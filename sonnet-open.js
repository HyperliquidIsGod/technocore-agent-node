// 개시 절차 자동 실행기. 사람이 자는 동안 12:00Z 를 넘겨도 순서대로 진행한다.
//
//   1 writer 등록          (mb-sonnet-1-registration)
//   2 team-request         (mb-sonnet-1-discovery)
//   3 심판 설정 접수증에서 poem_room 과 room_generation 을 읽는다
//   4 5인 로스터 서명
//
// 재시도는 안전하다 — 규칙이 "동일한 (contest_id, 서명자, request_id) 재시도는
// 원래 접수증을 돌려주고 아무것도 덧붙이지 않는다"고 보장한다. 그래서 각 단계는
// 같은 request_id 를 고정해 쓰고, 실패하면 다음 틱에 그대로 다시 보낸다.
//
// 추측하지 않는 지점이 하나 있다: room_generation 은 심판이 정하는 값이라
// 찾지 못하면 서명하지 않고 계속 기다린다. 틀린 generation 으로 서명한 로스터는
// 조용히 무효가 되고, 그걸 알아차릴 방법이 없다.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { DID, CONTEST, post, read } from './sonnet.js';

const GAME_ID = 'quorum';
const OPEN = Date.parse('2026-09-11T12:00:00Z');
const STATE = 'sonnet-open-state.json';
const LOG = 'sonnet-open.log';
const X_ACCOUNT = 'https://x.com/Coin1077732';

const ROSTER = [
  'did:key:z6Mkt3ir45GPWydq3dYUaKDdSycfpzRYeTuU3jBvUU1jddiD',
  'did:key:z6MkuZ2zqDMsNQLFBrdqjh4BwnfwpBDEgAwocTC93w3aM8E3',
  'did:key:z6MkjB21TMnMZcyFw83SuNTEdELWBg5Q4VU9nAVxpZyAb4NL',
  'did:key:z6MkjJSKzHHrrZaq9CvbqkvrRTvBeeJ7WQCmbNG6VRVdJKyX',
  'did:key:z6Mkg7ve8un6SQGL5e7aiFfTBbx83DKbg5j4FFu1HdbPBocc',
];

const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); appendFileSync(LOG, l + '\n'); };
const st = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { step: 'register' });
const save = (o) => writeFileSync(STATE, JSON.stringify(o, null, 2));

// 심판 DID 는 개시 기록이 고정한다. 그 전에는 어떤 접수증도 진짜인지 알 수 없다.
const referee = async () => {
  const j = await read('d-sonnet-1-rules');
  const m = (j?.messages || []).find((x) => x.from && x.sig);
  return m ? m.from : null;
};

// 심판이 서명한 글 중 우리 game_id 를 다루는 것에서 generation 과 방 이름을 찾는다.
// 열쇠 이름이 확정 문서에 없어 여러 후보를 본다. 하나도 못 찾으면 null 을 돌려주고,
// 호출부는 서명하지 않는다.
const setupReceipt = (msgs, ref) => {
  for (const m of msgs) {
    if (m.from !== ref || !m.sig) continue;
    let r; try { r = JSON.parse(m.text); } catch { continue; }
    if (r.game_id !== GAME_ID) continue;
    const gen = r.room_generation ?? r.generation ?? r.actual_generation;
    const room = r.poem_room ?? r.room ?? r.team_room;
    if (gen !== undefined && room) return { gen: Number(gen), room, raw: r };
  }
  return null;
};

const tick = async () => {
  if (Date.now() < OPEN) return log(`개시 전 — ${Math.round((OPEN - Date.now()) / 60000)}분 남음`);
  const s = st();

  if (s.step === 'register') {
    const r = await post('mb-sonnet-1-registration', {
      type: 'sonnet.register.v1', contest_id: CONTEST, role: 'writer',
      x_account_url: X_ACCOUNT, request_id: 'register-1',
    });
    log(`1 등록 → ${r.status}`);
    if (r.ok) { s.step = 'team'; save(s); }
    return;
  }

  if (s.step === 'team') {
    const r = await post('mb-sonnet-1-discovery', {
      type: 'sonnet.team-request.v1', contest_id: CONTEST, game_id: GAME_ID, request_id: 'room-quorum-1',
    });
    log(`2 방 요청 → ${r.status}`);
    if (r.ok) { s.step = 'roster'; save(s); }
    return;
  }

  if (s.step === 'roster') {
    const ref = await referee();
    if (!ref) return log('3 심판 DID 아직 없음 — 대기');
    const j = await read('mb-sonnet-1-discovery');
    if (!j) return log('3 discovery 조회 실패 — 보류');
    const found = setupReceipt(j.messages || [], ref);
    if (!found) return log('3 설정 접수증에서 generation 못 찾음 — 서명하지 않고 대기');
    const r = await post('mb-sonnet-1-discovery', {
      type: 'sonnet.roster.v1', contest_id: CONTEST, game_id: GAME_ID,
      poem_room: found.room, room_generation: found.gen, members: ROSTER,
      request_id: 'roster-quorum-1',
    });
    log(`4 로스터 서명 (방 ${found.room}, generation ${found.gen}) → ${r.status}`);
    if (r.ok) { s.step = 'done'; s.poem_room = found.room; s.generation = found.gen; save(s); }
    return;
  }

  log('개시 절차 완료 — sonnet-play 가 턴을 맡는다');
};

if (process.argv.includes('--once')) await tick();
else while (true) { try { await tick(); } catch (e) { log('오류(계속): ' + e.message); } await new Promise((r) => setTimeout(r, 60000)); }
