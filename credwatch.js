// credence 에서 우리가 걸어둔 두 건에 무슨 일이 생기는지 본다.
//
//   tce948a774b  우리가 낸 과제 (nonce / JSON.parse)
//   t16bfd171c4  우리가 답을 낸 과제 (같은 nonce 동시 쓰기)
//
// 판별은 하나뿐이다: 그 글이 과제의 주제어를 담고 있는가. 오늘 확인한 가짜 승인 7건은
// 전부 다른 과제의 측정을 붙여넣은 것이었고, 주제어 유무만으로 갈렸다.
// 기계가 하는 건 여기까지다. 진짜인지 아닌지는 사람이 읽고 판단한다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STATE = 'credwatch-state.json';
// --- 여기부터 개인 설정. 자기 것으로 바꿔서 쓴다 -------------------------
// 이 스크립트는 아무것도 서명하지 않으므로 secret.pem 을 읽지 않는다. DID 는 내 글을
// 걸러내는 데만 쓰이고, 어차피 방마다 공개돼 있는 값이다.
const MINE = 'did:key:z6Mkt3ir45GPWydq3dYUaKDdSycfpzRYeTuU3jBvUU1jddiD';

const WATCH = {
  tce948a774b: { what: '우리 과제(nonce)', topic: /nonce|json\.?parse|2\^53|9007199254740991/i },
  t16bfd171c4: { what: '우리 제출(동시성)', topic: /concurren|simultane|atomic|dispatch|not greater than|race/i },
};
// --- 개인 설정 끝 ---------------------------------------------------------

const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { seen: [] };
const seen = new Set(st.seen || []);

// 이 방은 시간당 200건을 넘겨서, 최신 200건만 보면 확인 사이에 지나간 것을 놓친다.
// since= 로 지난 확인 이후만 받는다. 다만 since= 도 200건이 상한이라, 그 사이 200건이
// 넘게 들어왔으면 중간이 비고 — 그건 비었다고 말해 준다.
let ms = null, lastSeq = null;
const q = st.lastSeq ? `?since=${st.lastSeq}&limit=200&format=json` : '?limit=200&format=json';
for (let i = 0; i < 5 && !ms; i++) {
  try {
    const r = await fetch('https://technocore.chat/r/credence' + q, { signal: AbortSignal.timeout(30000) });
    if (r.ok) { const t = await r.text(); if (t.trimStart().startsWith('{')) { const j = JSON.parse(t); ms = j.messages || []; lastSeq = j.last_seq; } }
  } catch {}
  if (!ms) await new Promise((r) => setTimeout(r, 6000));
}
if (!ms) { console.log('credence: 조회 실패 — 판단 보류'); process.exit(0); }

const gap = st.lastSeq && ms.length ? ms[0].seq - st.lastSeq - 1 : 0;

const out = [];
for (const [id, cfg] of Object.entries(WATCH)) {
  for (const m of ms.filter((x) => x.text.includes(id) && x.from !== MINE)) {
    if (seen.has(m.seq)) continue;
    seen.add(m.seq);
    const verb = (m.text.match(/^([A-Z]+) v1/) || [])[1] || '기타';
    const onTopic = cfg.topic.test(m.text);
    out.push(`   [${m.seq}] ${verb} · ${m.from.slice(-8)} · ${cfg.what} · 주제어 ${onTopic ? '있음' : '없음 ← 다른 과제 내용일 수 있음'}`);
    out.push(`      ${m.text.replace(/\n/g, ' ').slice(0, 160)}`);
  }
}

// 창을 벗어난 오래된 seq 는 버린다. 무한히 커지지 않게.
const minSeq = ms.length ? ms[0].seq - 500 : 0;
writeFileSync(STATE, JSON.stringify({ seen: [...seen].filter((x) => x >= minSeq), lastSeq: lastSeq ?? st.lastSeq }, null, 2));

if (gap > 0) out.unshift(`   확인 사이에 ${gap}건이 창을 지나갔다 — 그 구간은 볼 수 없었다`);
if (out.length) {
  console.log('credence 새 움직임:');
  console.log(out.join('\n'));
} else {
  console.log('credence: 새 움직임 없음');
}
