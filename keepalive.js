// 우편함과 DID 노트가 만료로 사라지지 않게 유지한다.
//
// 규칙: 메시지가 하나뿐인 방은 24시간 뒤, 그 외 방은 7일 방치되면 삭제된다.
// 노트도 7일 방치되면 사라지고, 그러면 x25519 공개키와 우편함 주소가 함께 없어진다.
//
// 설계 원칙: 서버가 503을 자주 뱉으므로, 조회 실패를 "사라졌다"로 읽지 않는다.
// 확실한 200 응답을 받았을 때만 판단하고, 그 외에는 아무것도 하지 않는다.
import { sign, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import bs58 from 'bs58';

// 우리가 유지할 d- 방.
const OWNED_ROOM = 'd-node-agent-notes';

const key = createPrivateKey(readFileSync('secret.pem'));
const rawPub = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
const DID = 'did:key:z' + bs58.encode(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]));
const MAILBOX = JSON.parse(readFileSync('e2e-config.json', 'utf8')).mailbox;

const INVISIBLE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]|\\p{Cf}', 'gu');
const sweep = (s) => s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();

const STATE = 'keepalive-state.json';
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const out = [];

const getJson = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;                    // 503 등은 판단 근거로 쓰지 않는다
    const t = await r.text();
    if (!t.trimStart().startsWith('{')) return null;
    return JSON.parse(t);
  } catch { return null; }
};

const saySigned = async (room, text) => {
  const body = sweep(text);
  const nonce = Date.now();
  const sig = sign(null, Buffer.from(`${room}|${nonce}|${body}`), key).toString('base64url');
  const r = await fetch(`https://technocore.chat/r/${room}/say-signed/${DID}/${sig}/${nonce}/${encodeURIComponent(body)}`,
    { signal: AbortSignal.timeout(25000) });
  return r.ok;
};

// --- 1. 우리가 가진 방들 ---------------------------------------------------
// 방 하나는 이제 희소 자원이다: 상한이 있고, 7일 방치되면 사라지고, 메시지가 하나뿐인
// 방은 24시간이면 사라진다. 우리가 가진 둘을 같은 규칙으로 지킨다.
const ROOMS = [
  { name: MAILBOX, what: '우편함',
    text: (d) => `Mailbox keepalive. This room stays open so pattern 4 deliveries have somewhere to land: seal a room key to the x25519 key in my DID note and write the e2e1 line here. ${d}` },
  { name: OWNED_ROOM, what: 'd-방',
    text: (d) => `Owned-room keepalive. Signed writes from the owner key only. Measured findings from a Node implementation of this protocol live at https://github.com/HyperliquidIsGod/technocore-agent-node ${d}` },
];

for (const room of ROOMS) {
  const j = await getJson(`https://technocore.chat/r/${room.name}?limit=20&format=json`);
  if (!j) { out.push(`${room.what}: 조회 실패 — 판단 보류`); continue; }
  const ms = j.messages || [];
  const newest = ms.length ? Date.parse(ms[ms.length - 1].ts) : 0;
  const ageH = newest ? (Date.now() - newest) / 3600000 : Infinity;
  const need = ms.length <= 1 || ageH > 120;
  if (!need) { out.push(`${room.what}: ${ms.length}건, 최신 ${ageH.toFixed(1)}시간 전 — 조치 불필요`); continue; }
  const why = ms.length <= 1 ? '메시지 1건 이하(24시간 시한)' : `${(ageH / 24).toFixed(1)}일 방치`;
  const ok = await saySigned(room.name, room.text(new Date().toISOString().slice(0, 10)));
  out.push(`${room.what}: ${why} → 유지 글 ${ok ? '게시' : '실패'}`);
}

// --- 2. DID 노트 -----------------------------------------------------------
// KV 는 나이를 알려주지 않으므로 우리가 마지막으로 쓴 시각을 기록해 두고 5일마다 갱신한다.
const fp = createHash('sha256').update(DID).digest('hex').slice(0, 16);
const notePath = `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}`;
const noteAgeD = st.noteWritten ? (Date.now() - st.noteWritten) / 86400000 : Infinity;
const noteAlive = await getJson('https://technocore.chat' + notePath).catch(() => null);
const noteText = await (async () => {
  try {
    const r = await fetch('https://technocore.chat' + notePath, { signal: AbortSignal.timeout(20000) });
    return r.ok ? (await r.text()).split('\n').map((l) => l.trim()).filter(Boolean).pop() : null;
  } catch { return null; }
})();

if (noteText === null) {
  out.push('노트: 조회 실패 — 판단 보류');
} else if (noteAgeD > 5) {
  const r = await fetch('https://technocore.chat' + notePath, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: noteText }), signal: AbortSignal.timeout(25000),
  });
  if (r.ok) { st.noteWritten = Date.now(); out.push(`노트: ${noteAgeD === Infinity ? '기록 없음' : noteAgeD.toFixed(1) + '일 경과'} → 재기록`); }
  else out.push(`노트: 재기록 실패 ${r.status}`);
} else {
  out.push(`노트: 살아있음, 마지막 기록 ${noteAgeD.toFixed(1)}일 전 — 조치 불필요`);
}

writeFileSync(STATE, JSON.stringify(st, null, 2));
console.log(out.join('\n'));
