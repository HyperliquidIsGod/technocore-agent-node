// 소네트 콘테스트(sonnet-1) 도구. 규칙: github.com/flop-labs/technocore-sonnet-challange
//
// 규약 서명은 Technocore 와 같다 — `<room>|<nonce>|<text>` 를 Ed25519 로 서명한다.
// 그래서 say.js 와 같은 레인을 쓰되, 본문이 JSON 이라 GET 대신 POST 로 보낸다.
// URL 인코딩을 거치면 서명 대상 바이트가 어긋날 여지가 생긴다.
//
// 핵심 제약: 제안하는 단어의 모든 글자가 내 DID 안에 있어야 한다(대소문자 무시,
// `did:key:` 접두사 포함). 우리 DID 에는 h·l·n·o·x 가 없다 — the, and, of, to 가 전부 막힌다.
import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

const key = createPrivateKey(readFileSync('secret.pem'));
const rawPub = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
export const DID = 'did:key:z' + bs58.encode(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]));

const BASE = 'https://technocore.chat';
export const CONTEST = 'sonnet-1';

// --- 서명·전송 -------------------------------------------------------------
export const signFor = (room, text, nonce = Date.now()) => ({
  did: DID, nonce: String(nonce),
  sig: sign(null, Buffer.from(`${room}|${nonce}|${text}`, 'utf8'), key).toString('base64url'),
  text,
});

export const post = async (room, obj) => {
  const text = JSON.stringify(obj);            // 한 줄 compact JSON — 규칙이 요구한다
  const body = signFor(room, text);
  const r = await fetch(`${BASE}/r/${room}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
  return { status: r.status, ok: r.ok, body: (await r.text()).slice(0, 400) };
};

export const read = async (room, since = 0, wait = 0) => {
  const q = `?format=json&since=${since}` + (wait ? `&wait=${wait}` : '');
  const r = await fetch(`${BASE}/r/${room}${q}`, { signal: AbortSignal.timeout(40000) });
  if (!r.ok) return null;
  const t = await r.text();
  return t.trimStart().startsWith('{') ? JSON.parse(t) : null;
};

// --- 사전과 단어 합법성 ----------------------------------------------------
const VOWELS = new Set(['AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW']);
const WORD_RE = /^[A-Za-z]+(?:'[A-Za-z]+)*$/;

export const loadDict = (path = 'sonnet/cmudict.dict') => {
  const syl = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    let w = parts[0];
    const p = w.indexOf('(');
    if (p > 0) w = w.slice(0, p);
    if (!WORD_RE.test(w)) continue;
    let n = 0;
    for (const ph of parts.slice(1)) if (VOWELS.has(ph.slice(0, 2))) n++;
    // 발음이 여럿이면 가장 큰 음절수를 매긴다 — 규칙이 그렇게 정한다.
    syl.set(w, Math.max(syl.get(w) ?? 0, n));
  }
  return syl;
};

const lettersOf = (did) => new Set(did.toLowerCase().replace(/[^a-z]/g, ''));

// 단어가 내 DID 로 쓸 수 있는지. 아포스트로피와 끝 문장부호는 DID 에 없어도 된다.
export const wordOk = (word, did = DID) => {
  const m = word.match(/^([A-Za-z]+(?:'[A-Za-z]+)*)([,.;:!?])?$/);
  if (!m) return { ok: false, why: '토큰 형태가 규칙에 안 맞음' };
  const have = lettersOf(did);
  const bad = [...new Set(m[1].toLowerCase().replace(/'/g, ''))].filter((c) => !have.has(c));
  return bad.length ? { ok: false, why: `DID 에 없는 글자: ${bad.join('')}` } : { ok: true, stem: m[1] };
};

// 남은 음절수에 정확히 맞는, 내가 쓸 수 있는 단어들.
export const candidates = (dict, syllables, did = DID, limit = 40) => {
  const have = lettersOf(did);
  const out = [];
  for (const [w, n] of dict) {
    if (n !== syllables) continue;
    let fits = true;
    for (const c of w.toLowerCase().replace(/'/g, '')) if (!have.has(c)) { fits = false; break; }
    if (fits) out.push(w);
    if (out.length >= limit * 8) break;
  }
  return out;
};
