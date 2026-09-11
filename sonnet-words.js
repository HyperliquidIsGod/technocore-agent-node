// 단어 엔진. 규칙이 강제하는 세 가지를 동시에 만족하는 후보만 내놓는다:
//   1) 모든 글자가 내 DID 안에 있을 것
//   2) CMUdict 음절수가 남은 칸에 정확히 맞을 것 (10을 넘기면 거부, 다음 줄로 안 넘어간다)
//   3) 줄 끝이면 목표 운율족과 같은 소리로 끝날 것
//
// 3번이 이 도구의 존재 이유다. 사람이 손으로 고르면 운율 맞는 단어를 찾다가 음절을 놓치고,
// 음절을 맞추다가 DID 글자를 어긴다. 참조 저장소가 단어 탐색 도구를 비공개로 뺀 것도
// (AGENTS.md) 여기가 승부처라고 봤기 때문일 것이다.
import { readFileSync } from 'node:fs';
import { DID } from './sonnet.js';

const VOWELS = new Set(['AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW']);
const WORD_RE = /^[A-Za-z]+(?:'[A-Za-z]+)*$/;

const phones = new Map();   // 단어 → 음소 배열(첫 발음)
const syll = new Map();     // 단어 → 음절수(발음 여럿이면 최대값 — 규칙이 그렇게 센다)

for (const line of readFileSync('sonnet/cmudict.dict', 'utf8').split('\n')) {
  const p = line.split(/\s+/).filter(Boolean);
  if (!p.length) continue;
  let w = p[0];
  const i = w.indexOf('(');
  const alt = i > 0;
  if (alt) w = w.slice(0, i);
  if (!WORD_RE.test(w)) continue;
  const ph = p.slice(1);
  const n = ph.filter((x) => VOWELS.has(x.slice(0, 2))).length;
  syll.set(w, Math.max(syll.get(w) ?? 0, n));
  if (!alt || !phones.has(w)) phones.set(w, ph);
}

const letters = new Set(DID.toLowerCase().replace(/[^a-z]/g, ''));
const writable = (w) => { for (const c of w.toLowerCase().replace(/'/g, '')) if (!letters.has(c)) return false; return true; };

// 운율 열쇠: 마지막 강세 모음부터 끝까지. "day"와 "away"가 같은 족으로 묶인다.
export const rhymeKey = (w) => {
  const ph = phones.get(w.toLowerCase());
  if (!ph) return null;
  let start = -1;
  for (let i = ph.length - 1; i >= 0; i--) {
    if (VOWELS.has(ph[i].slice(0, 2))) { start = i; if (/1/.test(ph[i])) break; }
  }
  return start < 0 ? null : ph.slice(start).map((x) => x.replace(/\d/g, '')).join(' ');
};

export const fit = (n, { rhymesWith = null, limit = 60, mine = true } = {}) => {
  const key = rhymesWith ? rhymeKey(rhymesWith) : null;
  const out = [];
  for (const [w, s] of syll) {
    if (s !== n) continue;
    if (mine && !writable(w)) continue;
    if (key && rhymeKey(w) !== key) continue;
    out.push(w);
  }
  return out.slice(0, limit);
};

export const sylOf = (w) => syll.get(w.toLowerCase()) ?? null;
export const lineState = (words) => {
  let t = 0; const miss = [];
  for (const w of words) { const s = sylOf(w); if (s == null) miss.push(w); else t += s; }
  return { syllables: t, left: 10 - t, unknown: miss };
};

if (process.argv[1]?.endsWith('sonnet-words.js')) {
  const [, , cmd, a, b] = process.argv;
  if (cmd === 'fit') console.log(fit(+a, { rhymesWith: b || null }).join(' '));
  else if (cmd === 'line') { const ws = process.argv.slice(3); console.log(JSON.stringify(lineState(ws))); }
  else if (cmd === 'rhyme') console.log('운율열쇠:', rhymeKey(a), '\n', fit(+(b || 1), { rhymesWith: a }).join(' '));
  else console.log('사용법: fit <음절> [운율단어] | rhyme <단어> <음절> | line <단어...>');
}
