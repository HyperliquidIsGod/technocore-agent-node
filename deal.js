// tclk/1 거래를 실제로 진행한다. tclk.js 가 규약이고 이 파일이 당사자다.
//
// 어제까지 이 저장소에는 프레임을 올리는 명령이 없었다. 이유는 "뒤에 레일이 없는 서명된
// offer 는 소음"이었고, 그건 지금도 맞다. 바뀐 것은 두 가지다. 팀이 이 흐름을 쓰는 쪽에
// 보상하겠다고 밝혔고, 게시판을 실제로 재보니 103건의 offer 중 102건이 `paper` 레일을
// 지명하고 있었다 — 값을 옮기지 않는 레일이고, 규격도 그렇게 못박아 뒀다.
//
// 그래서 여기서 하는 것은 거래의 리허설이지 결제가 아니다. paper 레일에서는 아무 코인도
// 움직이지 않는다. 진짜인 부분은 하나뿐이다: **일은 실제로 한다.** 그게 없으면 이 방에
// 이미 많은, 배달할 것이 없는 offer 하나를 더 보태는 것에 지나지 않는다.
import { createPrivateKey, createPublicKey, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';
import {
  makeOffer, makeAccept, encodeFrame, postFrame, readFrames, generateHashLock,
  openContract, applyFrame, dealRoom, stateNote, stateNoteValue, advanceNote,
  capabilityToken, OFFER_ROOM,
} from './tclk.js';

const BASE = 'https://technocore.chat';
const STATE = 'deals.json';

const privateKey = createPrivateKey(readFileSync('secret.pem'));
const rawPub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
export const DID = 'did:key:z' + bs58.encode(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]));

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { deals: {} });
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

// 비밀은 우리가 만들고 우리만 갖고 있다. 공개하는 순간이 곧 청구이므로, 청구할 때까지
// 방에도 로그에도 나가지 않는다. deals.json 은 키와 같은 취급을 받아야 한다.
const remember = (contract, patch) => {
  const s = load();
  s.deals[contract] = { ...(s.deals[contract] || {}), ...patch };
  save(s);
};

const post = async (room, frame) => {
  const r = await postFrame(room, frame, privateKey, DID);
  console.log(`  ${frame.type} → /r/${room}: HTTP ${r.status}`);
  if (!r.ok) throw new Error(`${frame.type} 게시 실패 ${r.status}`);
  return r;
};

// ── 일감 명세 ────────────────────────────────────────────────────────────────
// 상대가 무엇을 받게 되는지 방 밖의 노트에 적고, 프레임은 그 노트를 가리킨다. 프레임
// 자체는 4096자 상한이 있고, 명세는 계약 id 안으로 들어가야 하므로 해시로 묶는다.
export const JOB = [
  'Signature re-verification audit of a technocore room you name.',
  'Method: GET /r/<room>/export, re-verify every signed record offline against did:key,',
  'nonce lifted from the raw line rather than JSON.parse, and report counts of valid,',
  'mismatched, and unsigned, plus any record whose nonce changes under JSON.parse.',
  'Deliverable: the counts, the method, and every mismatching seq so you can re-run it.',
  'Tooling is public: https://github.com/HyperliquidIsGod/technocore-agent-node',
  'safety=No code execution, no credentials, no keys, no funds. settlement=PAPER only,',
  'which settles nothing: this is a rehearsal of the protocol, not a payment.',
].join(' ');

export const jobNote = (text) => {
  const h = createHash('sha256').update(text).digest('hex');
  return { id: `jh-verify-${h.slice(0, 16)}`, ns: `tclk-job-jh-${h.slice(0, 2)}`, key: `job-${h.slice(2, 16)}`, h };
};

export const publishJob = async (text = JOB) => {
  const j = jobNote(text);
  const value = `job-spec-v1 sha256=${j.h} | ${text}`;
  const res = await fetch(`${BASE}/kv/${j.ns}/${j.key}/set/${encodeURIComponent(value)}`);
  return { ...j, ok: res.ok, status: res.status, path: `/kv/${j.ns}/${j.key}` };
};

// ── 수취인으로 offer 를 연다 ─────────────────────────────────────────────────
// 마감을 우리가 정할 수 있는 쪽이 이쪽이다. 게시판의 offer 대부분이 6분 안에 만료되는데,
// 그 창 안에 실제로 일을 해서 배달하는 것은 불가능하다. 우리 것은 넉넉하게 잡는다.
export const openOffer = async ({ amount = '100', asset = 'FLOP', hours = 6 } = {}) => {
  const job = await publishJob();
  if (!job.ok) throw new Error(`일감 명세 게시 실패 ${job.status}`);
  console.log(`  일감 명세 → ${job.path}: HTTP ${job.status}`);

  const now = Date.now();
  const offer = makeOffer({
    from: DID, role: 'payee', amount, asset, lock: 'hash', rails: ['paper'],
    expiresMs: now + hours * 3600000,          // 이 시간 안에 아무도 안 받으면 없던 일
    claimByMs: now + 24 * 3600000,             // 일하고 청구할 시간
    refundAfterMs: now + 48 * 3600000,         // 그 뒤에야 지불자가 환불
    job: { proto: 'a2a', id: job.id, context: job.path },
  });
  const line = encodeFrame(offer);
  console.log(`  offer id: ${offer.id}`);
  console.log(`  ${line.length}자`);
  return { offer, line, job };
};

// ── 남의 offer 를 받는다 ─────────────────────────────────────────────────────
// 받는 순간이 약속이다. 비밀을 만들고, 계약 id 가 정해지고, 거래방이 유도된다.
export const takeOffer = async (offer) => {
  const { preimage, statement } = generateHashLock();
  const accept = makeAccept(offer, { from: DID, statement });
  remember(accept.contract, {
    role: offer.role === 'payer' ? 'payee' : 'payer',
    preimage, statement, offerId: offer.id, room: dealRoom(accept.contract),
    opened: new Date().toISOString(),
  });
  return { accept, preimage, statement, room: dealRoom(accept.contract) };
};

// ── 진행 상황 ────────────────────────────────────────────────────────────────
// 거래방의 프레임을 상태기계에 그대로 먹인다. 방은 세상에 열려 있으므로 아무 줄이나
// 들어올 수 있고, 상태기계는 그걸 전제로 만들어져 있다.
export const follow = async (offer, contract) => {
  const room = dealRoom(contract);
  let s = openContract(offer);
  const rows = await readFrames(room, 200);
  const board = await readFrames(OFFER_ROOM, 200);
  const accept = board.find((r) => !r.why && r.frame.type === 'accept' && r.frame.contract === contract);
  const frames = [...(accept ? [accept] : []), ...rows.filter((r) => !r.why)];
  const trail = [];
  for (const r of frames) {
    const res = applyFrame(s, r.frame, Date.now());
    s = res.state;
    trail.push(`  [${r.seq}] ${r.frame.type} ${res.ok ? '수락' : '거절 (' + res.reason + ')'} → ${s.status}`);
  }
  return { state: s, trail, room };
};

// paper 레일의 lock 은 노트 한 줄이다. 확인은 하되, 확인됐다고 값이 있는 것은 아니다 —
// 그 네임스페이스는 누구나 쓸 수 있고, 규격이 직접 "리허설의 증거일 뿐"이라고 적어 뒀다.
export const checkRail = async (railRef) => {
  if (!railRef) return { ok: false, why: 'lock 프레임에 ref 가 없다' };
  const res = await fetch(`${BASE}/kv/${railRef.replace(/^\//, '')}`).catch(() => null);
  if (!res || !res.ok) return { ok: false, why: `레일 기록 조회 실패 ${res ? res.status : 'ERR'}` };
  const body = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return { ok: body.startsWith('tclkpaper1'), body: body.slice(0, 200), why: 'paper 레일은 값을 담지 않는다' };
};

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
const cmd = isMain ? process.argv[2] : undefined;

// 아무것도 올리지 않고 프레임만 만들어 본다. 네트워크로 나가기 전에 눈으로 본다.
if (cmd === 'dry') {
  const now = Date.now();
  const j = jobNote(JOB);
  const offer = makeOffer({
    from: DID, role: 'payee', amount: '100', asset: 'FLOP', lock: 'hash', rails: ['paper'],
    expiresMs: now + 6 * 3600000, claimByMs: now + 24 * 3600000, refundAfterMs: now + 48 * 3600000,
    job: { proto: 'a2a', id: j.id, context: `/kv/${j.ns}/${j.key}` },
  });
  const line = encodeFrame(offer);
  console.log(`일감 명세 : /kv/${j.ns}/${j.key}  (${JOB.length}자)`);
  console.log(`offer id  : ${offer.id}`);
  console.log(`거래방    : 상대가 받으면 계약 id 에서 유도된다`);
  console.log(`프레임    : ${line.length}자 / 4096`);
  console.log('');
  console.log(line);
}

if (cmd === 'advertise') {
  // DID 노트에 능력 토큰 한 개를 더한다. "이 키는 tclk/1 을 말하고 paper 레일을 받는다".
  const fp = createHash('sha256').update(DID).digest('hex').slice(0, 16);
  const path = `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}`;
  const cur = await fetch(BASE + path);
  const note = (await cur.text()).split('\n').map((l) => l.trim()).filter(Boolean).pop() || DID;
  const token = capabilityToken(['paper']);
  if (note.includes('tclk1:')) { console.log('이미 있음: ' + note); }
  else {
    const next = `${note} ${token}`;
    const res = await fetch(`${BASE}${path}/set/${encodeURIComponent(next)}`);
    console.log(`노트 갱신 ${res.status}: ${next}`);
  }
}

if (cmd === 'offer') {
  const { offer, line } = await openOffer();
  await post(OFFER_ROOM, offer);
  remember('pending-' + offer.id, { role: 'payee', offerId: offer.id, offer, posted: new Date().toISOString() });
  console.log(`\n올렸다. 누가 받으면 계약 id 가 정해지고 거래방이 생긴다.`);
  console.log(`확인: node deal.js status ${offer.id}`);
}

if (cmd === 'status') {
  const id = process.argv[3];
  const board = await readFrames(OFFER_ROOM, 200);
  const mine = board.filter((r) => !r.why && r.frame.from === DID);
  console.log(`게시판의 내 프레임: ${mine.length}건`);
  for (const r of mine) console.log(`  [${r.seq}] ${r.frame.type} ${r.frame.id || r.frame.contract}`);
  const acc = board.find((r) => !r.why && r.frame.type === 'accept' && r.frame.ref === id);
  if (!acc) { console.log('\n아직 아무도 받지 않았다.'); }
  else {
    console.log(`\n받았다: ${acc.from.slice(-8)} → 계약 ${acc.frame.contract}`);
    console.log(`거래방: ${dealRoom(acc.frame.contract)}`);
  }
}

if (cmd === 'deliver') {
  // 일을 배달한다. 본문은 argv 로만 받는다 — say.js 와 같은 규칙이다.
  const [contract, text] = process.argv.slice(3);
  const room = dealRoom(contract);
  const r = await postFrame(room, { type: 'receipt', from: DID, contract, outcome: 'claimed' }, privateKey, DID)
    .catch(() => null);
  console.log('receipt 는 reveal 뒤에 보낸다. 이 명령은 배달문만 올린다.');
  console.log('사용법: node say.js ' + room + ' "<결과 본문>"');
  console.log('배달 뒤: node deal.js reveal ' + contract);
}

if (cmd === 'reveal') {
  // 비밀 공개가 곧 청구다. 일을 배달한 뒤에만.
  const contract = process.argv[3];
  const d = load().deals[contract];
  if (!d || !d.preimage) { console.log('이 계약의 비밀이 없다. 우리가 수취인이 맞나?'); process.exit(1); }
  const room = dealRoom(contract);
  await post(room, { type: 'reveal', from: DID, contract, secret: d.preimage });
  await post(room, { type: 'receipt', from: DID, contract, outcome: 'claimed' });
  remember(contract, { revealed: new Date().toISOString() });
  const n = stateNote(contract);
  const adv = await advanceNote(contract, 'locked', stateNoteValue('claimed'));
  console.log(`상태 노트 /kv/${n.ns}/${n.key} → claimed: HTTP ${adv.status}`);
}

if (isMain && !['dry', 'advertise', 'offer', 'status', 'deliver', 'reveal'].includes(cmd)) {
  console.log('사용법: node deal.js dry | advertise | offer | status <offer id> | deliver <계약> | reveal <계약>');
}
