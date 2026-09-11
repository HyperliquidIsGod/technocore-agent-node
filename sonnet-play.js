// 대회 자동 턴 실행기. 세션에 사람이 없어도 우리 차례를 둔다.
//
// 왜 필요한가: 규칙에 턴 순서도 타이머도 없고 "같은 상태에 대한 첫 유효 제안이 채택"된다.
// 경쟁자 하나는 자기소개에 24/7 자동 턴을 내걸었다. 사람이 붙어 있을 때만 둘 수 있으면
// 새벽에 오는 차례를 통째로 넘긴다.
//
// 안전 원칙 셋:
//  1) 심판 DID 가 서명한 접수증만 상태로 인정한다. 방 이름이나 남의 주장은 상태가 아니다.
//  2) 직전 채택 기여자가 우리면 두지 않는다 (규칙이 연속 발언을 금지).
//  3) 로스터가 동결되기 전에는 아무것도 두지 않는다 — 첫 단어가 로스터를 영구 확정한다.
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { DID, CONTEST, post, read } from './sonnet.js';
import { fit, sylOf, lineState } from './sonnet-words.js';
import { infer } from './infer.js';

const GAME_ID = 'quorum';
const ROOM = `d-sonnet-1-team-${GAME_ID}`;
const STATE = 'sonnet-play-state.json';
const LOG = 'sonnet-play.log';

// 하루 판단 호출 상한 — auto.js 와 별개 프로세스이므로 예산을 따로 건다.
// Opus 5 실측 호출당 $0.042. 40 이면 최악 하루 $1.7.
const MAX_CALLS_PER_DAY = 40;

const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line); appendFileSync(LOG, line + '\n');
};

const st = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { calls: 0, day: 0, refereeDid: null });
const save = (o) => writeFileSync(STATE, JSON.stringify(o, null, 2));

// 심판 DID 는 d-sonnet-1-rules 의 개시 기록에 고정된다. 그게 없으면 아무 접수증도 믿지 않는다.
export const pinReferee = async () => {
  const j = await read('d-sonnet-1-rules');
  if (!j || !(j.messages || []).length) return null;
  // 그 방은 심판 소유이고 심판만 쓴다. 첫 서명 기록의 발신자가 심판이다.
  const first = j.messages.find((m) => m.from && m.sig);
  return first ? first.from : null;
};

// 접수증에서 현재 상태를 읽는다. 심판 서명이 아닌 글은 상태로 세지 않는다.
export const poemState = (msgs, refereeDid) => {
  let version = 0, hash = null, words = [], lastBy = null, frozen = false;
  for (const m of msgs) {
    if (m.from !== refereeDid) continue;
    let r; try { r = JSON.parse(m.text); } catch { continue; }
    if (r.contest_id !== CONTEST || r.game_id !== GAME_ID) continue;
    if (r.type === 'sonnet.roster-ready.v1') frozen = true;
    if (typeof r.version === 'number') version = Math.max(version, r.version);
    if (r.state_hash) hash = r.state_hash;
    if (Array.isArray(r.words)) words = r.words;
    else if (r.accepted_word) { words.push(r.accepted_word); lastBy = r.contributor ?? lastBy; }
    if (r.contributor) lastBy = r.contributor;
  }
  return { version, hash, words, lastBy, frozen };
};

// 현재 줄에 남은 음절. 10을 채우면 줄이 닫히고, 넘기는 단어는 거부된다.
export const lineNeed = (words) => {
  let line = [];
  for (const w of words) {
    line.push(w);
    if (lineState(line).syllables >= 10) line = [];
  }
  return { line, left: 10 - lineState(line).syllables };
};

const tick = async () => {
  const s = st();
  const today = Math.floor(Date.now() / 86400000);
  if (s.day !== today) { s.day = today; s.calls = 0; }

  if (!s.refereeDid) {
    s.refereeDid = await pinReferee();
    if (!s.refereeDid) { save(s); return log('심판 개시 기록 아직 없음 — 대기'); }
    log(`심판 DID 고정: …${s.refereeDid.slice(-10)}`);
  }

  const j = await read(ROOM);
  if (!j) { save(s); return log('팀 방 조회 실패 — 판단 보류'); }

  const p = poemState(j.messages || [], s.refereeDid);
  if (!p.frozen) { save(s); return log('roster-ready 접수증 없음 — 첫 단어 금지'); }
  if (p.words.length >= 140) { save(s); return log('시가 다 찼다 — 중단'); }
  if (p.lastBy === DID) { save(s); return log('직전 채택이 우리 — 연속 불가, 대기'); }
  if (s.calls >= MAX_CALLS_PER_DAY) { save(s); return log('판단 상한 도달'); }

  const { line, left } = lineNeed(p.words);
  if (left <= 0) { save(s); return log('줄 상태 이상 — 보류'); }

  // 우리 DID 로 쓸 수 있고 남은 칸에 정확히 맞는 후보. 여기서 이미 규칙 위반은 걸러진다.
  const cands = [];
  for (let n = 1; n <= Math.min(left, 4); n++) cands.push(...fit(n, { limit: 40 }));
  if (!cands.length) { save(s); return log(`남은 ${left}음절에 쓸 수 있는 단어 없음 — 대기`); }

  const prompt = `You are writing one word of a collaborative sonnet. Choose the single best next word.

Line so far: ${line.join(' ') || '(empty line)'}
Syllables remaining in this line: ${left}
Lines completed: ${Math.floor(p.words.length ? p.words.length : 0)}
Poem so far: ${p.words.join(' ')}

Choose ONE word from this list. Every word here is already legal for me to write and fits the syllable count. Pick for sense, meter (iambic), and rhyme position.

${cands.slice(0, 120).join(' ')}

Output ONLY the chosen word, nothing else.`;

  s.calls++;
  let pick;
  try { ({ text: pick } = await infer({ prompt, maxTokens: 2000 })); }
  catch (e) { save(s); return log('추론 에러: ' + e.message); }
  pick = (pick || '').trim().split(/\s+/)[0].replace(/[^A-Za-z']/g, '');

  if (!cands.includes(pick.toLowerCase())) { save(s); return log(`모델이 목록 밖 단어 제시(${pick}) — 버림`); }

  const r = await post(ROOM, {
    type: 'sonnet.word.v1', contest_id: CONTEST, game_id: GAME_ID,
    room_generation: j.generation ?? 0, version: p.version,
    previous_state_hash: p.hash, word: pick,
    request_id: `w-${p.version}-${Date.now().toString(36)}`,
  });
  save(s);
  log(`제안 "${pick}" (${sylOf(pick)}음절, 남은칸 ${left}) → ${r.status} ${r.ok ? '전송됨' : r.body.slice(0, 120)}`);
};

if (process.argv[1]?.endsWith('sonnet-play.js')) {
  if (process.argv.includes('--once')) await tick();
  else while (true) { try { await tick(); } catch (e) { log('오류(계속): ' + e.message); } await new Promise((r) => setTimeout(r, 45000)); }
}
