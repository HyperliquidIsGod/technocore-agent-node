// 확정 텍스트가 이 로스터로 실제 쓰일 수 있는지 판정한다.
//
// sonnet_validate.py 는 형식만 본다 — 14줄, 10음절, 사전 등재. 그건 누가 어떤 글자를
// 쓸 수 있는지 모른다. 여기서 죽는 방식은 따로 있다:
//
//   규칙: 직전에 채택된 기여자는 다음 단어를 제안할 수 없다.
//   따라서 확정 텍스트는 "모든 단어를 그 글자를 가진 멤버에게 배정하되
//   같은 멤버가 연속 두 단어를 맡지 않는" 배정이 존재할 때만 쓸 수 있다.
//
// 단어 하나하나가 전부 합법인데도 그런 배정이 아예 없을 수 있다. 그 경우 첫 단어를
// 놓는 순간 로스터가 동결되고, 막히는 지점에 도달해서야 알게 된다 — 되돌릴 수 없다.
//
// (위치, 직전 배정자) 상태의 DP 로 판정한다. 멤버 5명이면 상태가 작아서 즉시 끝난다.
const LET = (did) => new Set(did.toLowerCase().replace(/[^a-z]/g, ''));
const canSpell = (set, word) => {
  for (const c of word.toLowerCase().replace(/[^a-z']/g, '').replace(/'/g, '')) if (!set.has(c)) return false;
  return true;
};

// members: [{name, did}], words: 텍스트를 공백으로 나눈 배열
export const assign = (members, words) => {
  const sets = members.map((m) => LET(m.did));
  const n = words.length, k = members.length;
  const able = words.map((w) => sets.map((s) => canSpell(s, w)));

  // 어떤 멤버도 못 쓰는 단어가 있으면 배정 이전에 끝이다.
  for (let i = 0; i < n; i++) {
    if (!able[i].some(Boolean)) {
      const miss = [...new Set(words[i].toLowerCase().replace(/[^a-z]/g, ''))]
        .filter((c) => !sets.some((s) => s.has(c)));
      return { ok: false, at: i, word: words[i], why: `아무도 못 쓰는 글자: ${miss.join('')}` };
    }
  }

  // DP: reach[i][j] = i번째 단어를 j가 맡는 것이 가능한가
  const reach = Array.from({ length: n }, () => new Array(k).fill(false));
  for (let j = 0; j < k; j++) reach[0][j] = able[0][j];
  for (let i = 1; i < n; i++)
    for (let j = 0; j < k; j++)
      if (able[i][j]) for (let p = 0; p < k; p++) if (p !== j && reach[i - 1][p]) { reach[i][j] = true; break; }

  const last = reach[n - 1].findIndex(Boolean);
  if (last < 0) {
    // 어디서 끊겼는지 정확히 짚어준다 — "안 된다"보다 "여기가 막힌다"가 고칠 수 있다.
    for (let i = 0; i < n; i++) if (!reach[i].some(Boolean))
      return { ok: false, at: i, word: words[i], why: `여기서 연속 배정 제약에 막힘 (직전 단어를 맡을 수 있는 사람이 이 단어도 유일하게 맡아야 함)` };
    return { ok: false, why: '배정 불가' };
  }

  // 역추적해서 실제 배정 하나를 만든다. 부하가 고르도록 덜 쓴 멤버를 먼저 고른다.
  const pick = new Array(n).fill(-1);
  pick[n - 1] = last;
  for (let i = n - 2; i >= 0; i--) {
    const cands = [];
    for (let p = 0; p < k; p++) if (reach[i][p] && p !== pick[i + 1]) cands.push(p);
    const load = new Array(k).fill(0);
    for (let x = i + 1; x < n; x++) if (pick[x] >= 0) load[pick[x]]++;
    cands.sort((a, b) => load[a] - load[b]);
    pick[i] = cands[0];
  }
  const load = new Array(k).fill(0);
  for (const p of pick) load[p]++;
  return { ok: true, assignment: pick.map((p, i) => ({ word: words[i], by: members[p].name })), load: members.map((m, j) => ({ name: m.name, words: load[j] })) };
};

export const ROSTER = [
  { name: 'jh',     did: 'did:key:z6Mkt3ir45GPWydq3dYUaKDdSycfpzRYeTuU3jBvUU1jddiD' },
  { name: '3aM8E3', did: 'did:key:z6MkuZ2zqDMsNQLFBrdqjh4BwnfwpBDEgAwocTC93w3aM8E3' },
  { name: 'yAb4NL', did: 'did:key:z6MkjB21TMnMZcyFw83SuNTEdELWBg5Q4VU9nAVxpZyAb4NL' },
  { name: 'VdJKyX', did: 'did:key:z6MkjJSKzHHrrZaq9CvbqkvrRTvBeeJ7WQCmbNG6VRVdJKyX' },
  { name: 'bPBocc', did: 'did:key:z6Mkg7ve8un6SQGL5e7aiFfTBbx83DKbg5j4FFu1HdbPBocc' },
];

if (process.argv[1]?.endsWith('sonnet-assign.js')) {
  const { readFileSync } = await import('node:fs');
  const f = process.argv[2];
  if (!f) { console.log('사용법: node sonnet-assign.js <텍스트파일>'); process.exit(1); }
  const words = readFileSync(f, 'utf8').split(/\s+/).filter(Boolean);
  const r = assign(ROSTER, words);
  if (!r.ok) { console.log(`✗ 쓸 수 없음 — ${r.at + 1}번째 단어 "${r.word}": ${r.why}`); process.exit(2); }
  console.log('✓ 배정 가능');
  console.log('  부하:', r.load.map((l) => `${l.name} ${l.words}`).join(' · '));
}
