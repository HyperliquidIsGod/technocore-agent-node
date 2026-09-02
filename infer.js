// 모델 호출 한 군데. 지금은 Anthropic 으로 나가지만, 그건 설정값이지 코드가 아니다.
//
// 이유: 에어드랍의 잠금 해제가 "쓴 만큼"이다 — 추론에 3 FLOP 을 태워야 잠긴 1이 풀린다.
// 그러니 Q4 에 파우셋이 열리면 이 에이전트의 판단 호출이 그 네트워크로 나가야 하고,
// 그때 코드를 고치고 있으면 늦다. 엔드포인트가 공개되면 .env 세 줄이 바뀐다.
//
// 아직 그 API 의 모양을 모르므로 둘을 다 지원한다: Anthropic 의 /v1/messages 와
// OpenAI 호환 /v1/chat/completions. 추론 네트워크는 대개 후자를 흉내내지만, 공개되기
// 전에 단정하지 않는다 — 다르면 어댑터를 하나 더 넣으면 되고, 부르는 쪽은 그대로다.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

// .env 에서 값을 읽는다. 값에 '=' 가 들어가도 잘리지 않도록 첫 '=' 뒤 전부를 취한다.
export const readEnv = (name, fallback) => {
  if (process.env[name]) return process.env[name];
  if (existsSync('.env')) {
    const line = readFileSync('.env', 'utf8')
      .split(/\r?\n/).map((l) => l.trim())
      .find((l) => l.startsWith(name + '='));
    if (line) {
      const v = line.slice(name.length + 1).replace(/^(['"])(.*)\1$/, '$2').trim();
      if (v) return v;
    }
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`.env 에 ${name} 가 없습니다`);
};

export const config = () => {
  const provider = readEnv('INFERENCE_PROVIDER', 'anthropic');
  return {
    provider,
    base: readEnv('INFERENCE_BASE_URL', provider === 'anthropic' ? 'https://api.anthropic.com' : ''),
    model: readEnv('INFERENCE_MODEL', 'claude-sonnet-4-6'),
    key: readEnv('INFERENCE_API_KEY', null) ?? readEnv('ANTHROPIC_API_KEY'),
    log: readEnv('INFERENCE_LOG', 'inference.log'),
  };
};

// 쓴 만큼이 곧 잠금 해제이므로, 쓴 양을 우리가 직접 센다. 남의 대시보드를 믿을 일이
// 아니고, 나중에 "얼마나 태웠나"를 증명해야 할 수도 있다.
const record = (cfg, usage, ms) => {
  if (!cfg.log) return;
  try {
    appendFileSync(cfg.log, JSON.stringify({
      ts: new Date().toISOString(), provider: cfg.provider, model: cfg.model,
      in: usage.input ?? null, out: usage.output ?? null, ms,
    }) + '\n');
  } catch { /* 기록 실패가 판단을 막지는 않는다 */ }
};

const ADAPTERS = {
  // Anthropic Messages API
  anthropic: {
    url: (cfg) => `${cfg.base}/v1/messages`,
    headers: (cfg) => ({ 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' }),
    body: (cfg, { prompt, maxTokens, system }) => JSON.stringify({
      model: cfg.model, max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    read: (out) => {
      if (out.error) throw new Error(out.error.message);
      const block = (out.content || []).find((c) => c.type === 'text');
      if (!block) throw new Error('텍스트 블록이 없는 응답');
      return { text: block.text, usage: { input: out.usage?.input_tokens, output: out.usage?.output_tokens } };
    },
  },
  // OpenAI 호환 /v1/chat/completions — 대부분의 추론 네트워크가 내미는 모양
  openai: {
    url: (cfg) => `${cfg.base}/v1/chat/completions`,
    headers: (cfg) => ({ 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` }),
    body: (cfg, { prompt, maxTokens, system }) => JSON.stringify({
      model: cfg.model, max_tokens: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    }),
    read: (out) => {
      if (out.error) throw new Error(out.error.message || String(out.error));
      const text = out.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('메시지 내용이 없는 응답');
      return { text, usage: { input: out.usage?.prompt_tokens, output: out.usage?.completion_tokens } };
    },
  },
};

// 한 번의 판단. 실패는 던진다 — 부르는 쪽이 이미 오류를 로그로 남기고 넘어간다.
export const infer = async ({ prompt, maxTokens = 300, system, timeoutMs = 60000 }, cfg = config()) => {
  const a = ADAPTERS[cfg.provider];
  if (!a) throw new Error(`모르는 INFERENCE_PROVIDER: ${cfg.provider} (${Object.keys(ADAPTERS).join(', ')})`);
  if (!cfg.base) throw new Error('INFERENCE_BASE_URL 가 비어 있습니다');
  const t0 = Date.now();
  const res = await fetch(a.url(cfg), {
    method: 'POST', headers: a.headers(cfg), body: a.body(cfg, { prompt, maxTokens, system }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  const parsed = a.read(out);
  record(cfg, parsed.usage, Date.now() - t0);
  return parsed;
};

// 얼마나 태웠는지 합계. Q4 에 "3 쓰면 1 풀린다"를 우리 숫자로 확인하기 위한 것.
export const spent = (file = 'inference.log') => {
  if (!existsSync(file)) return { calls: 0, input: 0, output: 0 };
  let calls = 0, input = 0, output = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); calls++; input += r.in || 0; output += r.out || 0; } catch {}
  }
  return { calls, input, output };
};
