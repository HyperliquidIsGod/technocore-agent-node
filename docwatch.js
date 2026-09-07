// flop.finance 문서가 바뀌면 알려준다.
//
// 왜 필요한가: 에이전트 몫의 배분 정책이 아직 비준되지 않았다(옐로페이퍼 E.40 —
// "Onward distribution from either pool MUST NOT occur until its distribution
// policy is ratified"). 규칙이 정해지는 날 그 페이지가 조용히 바뀔 것이고,
// 트위터 요약을 기다리는 것보다 원문을 직접 보는 편이 빠르고 정확하다.
//
// 설계 원칙은 keepalive.js 와 같다: 조회에 실패하면 "바뀌었다"고 말하지 않는다.
// 200 을 확실히 받았을 때만 판단하고, 그 외에는 판단을 보류한다. 서버가 잠깐
// 죽은 것을 "규칙이 사라졌다"로 읽으면 안 된다.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

const DIR = 'docwatch';            // 페이지 본문 스냅샷이 쌓이는 곳
const BASE = 'https://flop.finance';
const PAGES = [
  ['teaser',       '/teaser/'],
  ['agent',        '/intro/agent/'],
  ['miner',        '/intro/miner/'],
  ['validator',    '/intro/validator/'],
  ['verification', '/intro/verification/'],
  ['revenue',      '/intro/revenue/'],
  ['yellowpaper',  '/intro/yellowpaper/'],
];

// 본문만 남긴다. script/style 을 먼저 지우지 않으면 그 안의 코드가 텍스트로 섞인다.
const textOf = (html) => {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  let s = main ? main[1] : html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  // 블록 태그는 줄바꿈으로 바꿔야 문단이 한 줄로 뭉치지 않는다. 줄 단위로 비교하므로
  // 이게 어긋나면 문서 전체가 한 줄이 되어 "한 줄 바뀜"만 남고 무엇이 바뀌었는지 사라진다.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|table|thead|tbody)>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n')
       .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
};

const get = async (url) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const t = await r.text();
        if (t.length > 500) return t;          // 오류 페이지는 대개 짧다
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
};

if (!existsSync(DIR)) mkdirSync(DIR);
const out = [];

for (const [name, path] of PAGES) {
  const html = await get(BASE + path);
  if (!html) { out.push(`${name}: 조회 실패 — 판단 보류`); continue; }

  const now = textOf(html);
  const file = `${DIR}/${name}.txt`;

  if (!existsSync(file)) {
    writeFileSync(file, now);
    out.push(`${name}: 기준 저장 (${now.split('\n').length}줄)`);
    continue;
  }

  const before = readFileSync(file, 'utf8');
  if (before === now) { out.push(`${name}: 변화 없음`); continue; }

  // 줄 단위 추가/삭제만 본다. 문서 개정은 문단이 통째로 바뀌는 식이라 이걸로 충분하고,
  // 완전한 diff 를 구현하는 것보다 읽기 쉽다.
  const oldSet = new Set(before.split('\n'));
  const newSet = new Set(now.split('\n'));
  const added = now.split('\n').filter((l) => !oldSet.has(l));
  const removed = before.split('\n').filter((l) => !newSet.has(l));

  writeFileSync(file, now);
  out.push(`${name}: ★ 변경 — 추가 ${added.length}줄, 삭제 ${removed.length}줄`);
  for (const l of removed.slice(0, 12)) out.push(`    - ${l.slice(0, 200)}`);
  for (const l of added.slice(0, 12)) out.push(`    + ${l.slice(0, 200)}`);
  if (added.length > 12 || removed.length > 12) out.push(`    (그 외는 ${DIR}/${name}.txt 와 git 이력으로)`);
}

console.log(out.join('\n'));
