// 대회 자동 턴 실행기 (심판 부재 판 · 2026-09-11 12:0xZ 개정).
//
// 개시 시각이 지나도 FLOP Labs 가 d-sonnet-1-rules 에 심판 DID 를 고정하지 않았고,
// 어느 방에서도 접수증이 발행되지 않았다. 규칙의 "referee receipt = 채택" 경로가
// 존재하지 않으므로, 팀 방에 올라온 허용된 키의 서명 글 자체가 시의 상태다.
// 다른 팀들도 같은 판단으로 쓰고 있다(silicon-mind 는 이미 version 6).
//
// 모델을 쓰지 않는다. 팀이 seq 217 에서 합의한 절차가 "확정 텍스트에 없는 단어는
// 아무도 두지 않는다" 이므로, 다음 단어는 고를 대상이 아니라 이미 정해져 있다.
// 여기가 하는 일은 그 단어가 지금 우리 차례이고 우리가 쓸 수 있는지 판정하는 것뿐이다.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { DID, CONTEST, post, read } from './sonnet.js';
import { fetchExport, parseLine } from './archive.js';
import { wordOk } from './sonnet.js';

// 대회·팀은 바뀐다. sonnet-1 은 심판이 끝내 안 왔고 sonnet-2 가 실제로 돌아간다.
// 코드에 박아두면 옮길 때마다 고쳐야 하므로 설정 파일에서 읽는다.
// sonnet-play.json: {"contest":"sonnet-2","game":"...","room":"d-sonnet-2-team-...","me":"jh","roster":[...]}
const CFG = existsSync('sonnet-play.json') ? JSON.parse(readFileSync('sonnet-play.json', 'utf8')) : null;
const GAME_ID = CFG?.game ?? 'quorum';
const ROOM = CFG?.room ?? `d-sonnet-1-team-${GAME_ID}`;
const CONTEST_ID = CFG?.contest ?? CONTEST;
const DISCOVERY = `mb-${CONTEST_ID}-discovery`;
const FROZEN = 'sonnet-frozen.txt';
const SIGNERS = 'sonnet-signers.txt';   // "단어@서명자" 목록. 없으면 아무것도 두지 않는다.
const ME = CFG?.me ?? 'jh';   // 팀이 합의한 확정 텍스트. 없으면 아무것도 두지 않는다.
const LOG = 'sonnet-play.log';

const ROSTER = CFG?.roster ?? [];

const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(LOG, l + '\n'); };

// 로스터 전원이 discovery 에 동일 로스터를 서명했는가. 심판의 roster-ready 가 없으므로
// 이것이 동결 조건이다. 첫 단어는 로스터를 영구 확정하니 전원 서명 전에는 절대 두지 않는다.
export const rosterSigned = (msgs) => {
  const signed = new Set();
  for (const m of msgs) {
    if (!m.from || !m.sig || !ROSTER.includes(m.from)) continue;
    let r; try { r = JSON.parse(m.text); } catch { continue; }
    if (r.type === 'sonnet.roster.v1' && r.contest_id === CONTEST_ID && r.game_id === GAME_ID
        && Array.isArray(r.members) && r.members.length === ROSTER.length
        && ROSTER.every((d) => r.members.includes(d))) signed.add(m.from);
  }
  return signed;
};

// 팀 방의 시 상태. 허용된 로스터 키가 서명한 word 프레임만 센다.
export const words = (msgs) => {
  const out = [];
  for (const m of msgs) {
    if (!m.from || !m.sig || !ROSTER.includes(m.from)) continue;
    let r; try { r = JSON.parse(m.text); } catch { continue; }
    if (r.type === 'sonnet.word.v1' && r.contest_id === CONTEST_ID && r.game_id === GAME_ID && r.word)
      out.push({ word: r.word, by: m.from, seq: m.seq });
  }
  return out;
};

const tick = async () => {
  if (!CFG || !ROSTER.length) return log('sonnet-play.json 없음 — 소속 팀이 정해지기 전까지 대기');
  if (!existsSync(FROZEN)) return log('확정 텍스트 없음 — 팀 합의 전까지 두지 않음');
  const frozen = readFileSync(FROZEN, 'utf8').split(/\s+/).filter(Boolean);

  // discovery 는 기본 읽기가 최근 50건만 준다. 로스터 서명은 몇 시간에 걸쳐 들어오므로
  // 그 창으로 보면 먼저 서명한 사람이 안 보이고 영원히 5/5 가 안 된다. export 로 전체를 받는다.
  let disc;
  try { disc = { messages: (await fetchExport(DISCOVERY)).split('\n').filter(Boolean).map(parseLine) }; }
  catch (e) { return log('discovery export 실패 — 보류: ' + e.message); }
  const signed = rosterSigned(disc.messages || []);
  if (signed.size < ROSTER.length)
    return log(`로스터 서명 ${signed.size}/${ROSTER.length} — 전원 서명 전엔 첫 단어 금지`);

  const j = await read(ROOM);
  if (!j) return log('팀 방 조회 실패 — 보류');
  const placed = words(j.messages || []);

  if (placed.length >= frozen.length) return log('확정 텍스트를 다 놓았다 — 완료');
  const next = frozen[placed.length];

  const last = placed[placed.length - 1];
  if (last && last.by === DID) return log(`직전이 우리("${last.word}") — 연속 불가, 대기`);

  // 쓸 수 있다고 아무거나 잡지 않는다. B 에는 한 명만 쓸 수 있는 단어가 18개 있고,
  // 그중 17개는 바로 앞 단어를 같은 사람이 잡으면 영구 교착이다(대체도 되감기도 없다).
  // 그래서 표에 배정된 것만 두고, 합법이어도 남의 몫이면 앉아 있는다.
  if (existsSync(SIGNERS)) {
    const table = readFileSync(SIGNERS, 'utf8').split(/\s+/).filter(Boolean);
    const cell = table[placed.length];
    const owner = cell && cell.slice(cell.lastIndexOf('@') + 1);
    if (!owner) return log(`서명자 표에 ${placed.length + 1}번째 항목 없음 — 대기`);
    if (owner !== ME) return log(`${placed.length + 1}번째 "${next}" 는 ${owner} 몫 — 쓸 수 있어도 양보`);
  } else {
    return log('서명자 표 없음 — 탐욕적 배치는 교착 위험이라 두지 않음');
  }

  const ok = wordOk(next);
  if (!ok.ok) return log(`다음 단어 "${next}"는 우리가 못 씀 (${ok.why}) — 표가 잘못됨, 중단`);

  const r = await post(ROOM, {
    type: 'sonnet.word.v1', contest_id: CONTEST_ID, game_id: GAME_ID,
    room_generation: j.generation ?? 0, version: placed.length,
    previous_state_hash: last ? String(last.seq) : null,
    word: next, request_id: `w-${placed.length}-${Date.now().toString(36)}`,
  });
  log(`${placed.length + 1}번째 "${next}" → ${r.status} ${r.ok ? '전송' : r.body.slice(0, 120)}`);
};

// 메인 모듈로 실행될 때만 돈다. 이 가드가 없으면 import 하는 쪽에서 무한 루프가 시작된다.
if (process.argv[1]?.endsWith('sonnet-play.js')) {
  if (process.argv.includes('--once')) await tick();
  else while (true) { try { await tick(); } catch (e) { log('오류(계속): ' + e.message); } await new Promise((r) => setTimeout(r, 30000)); }
}
