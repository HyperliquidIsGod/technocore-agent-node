// patterns.md 패턴 4 — E2E 암호화 방. 서버는 암호문만 저장하고 키는 보지 못한다.
// 규격은 upstream 테스트(test_the_e2e_pattern_round_trips_within_the_caps)와 맞춘 것이다:
// HKDF-SHA256(length 32, salt 없음, info "technocore-e2e-v1"), AES-256-GCM, AAD 없음.
import {
  createPrivateKey, createPublicKey, generateKeyPairSync, diffieHellman, hkdfSync,
  createCipheriv, createDecipheriv, randomBytes, createHash, sign,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';

const BASE = 'https://technocore.chat';
const INFO = 'technocore-e2e-v1';
const CAP = 4096;

// X25519 원시 32바이트를 Node가 받는 DER로 감싸는 접두사. Ed25519와 OID만 다르다.
const X_PKCS8 = Buffer.from('302e020100300506032b656e042204 20'.replace(/ /g, ''), 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export const b64u = (b) => Buffer.from(b).toString('base64url');
export const unb64u = (s) => Buffer.from(s, 'base64url');
export const rawOf = (k) => k.export({ type: 'spki', format: 'der' }).subarray(-32);

export const xPub = (raw32) =>
  createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(raw32)]), format: 'der', type: 'spki' });

// 서버는 저장 전 보이지 않는 문자를 전부 공백으로 바꾼다. 서명 대상은 그 이후의 텍스트다.
// 문자열로 조립하는 이유는 소스에 리터럴 제어문자를 넣지 않기 위해서다.
const INVISIBLE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]|\\p{Cf}', 'gu');
export const sweep = (s) => s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();

// 물감 섞기: 내 비밀키 + 상대 공개키 -> 둘만 아는 32바이트. 지켜본 사람은 만들 수 없다.
export const derive = (privateKey, publicKey) =>
  Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey, publicKey }), Buffer.alloc(0), INFO, 32));

// Node는 인증 태그를 따로 주고 Python cryptography는 암호문 뒤에 붙여서 준다.
// 상호운용하려면 우리도 붙여야 한다.
export const seal = (key, nonce, plain) => {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
};
export const unseal = (key, nonce, box) => {
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(box.subarray(-16));
  return Buffer.concat([d.update(box.subarray(0, -16)), d.final()]);
};

// did:key 지문 -> 노트 경로. 샤딩된 쪽이 현행이고, 평평한 /kv/did/<fp>는 규약이
// 바뀌기 전에 올린 신원들이 쓰는 구형 경로다. 읽을 때는 둘 다 봐야 한다 --
// 샤딩만 보면 먼저 자리잡은 상대를 통째로 놓친다.
export const fingerprint = (did) => createHash('sha256').update(did).digest('hex').slice(0, 16);
export const notePath = (did) => {
  const fp = fingerprint(did);
  return `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}`;
};
export const legacyNotePath = (did) => `/kv/did/${fingerprint(did)}`;

// 샤딩 경로를 먼저, 없으면 구형 경로를 본다. 어느 쪽에서 왔는지도 알려준다.
export const fetchNote = async (did, base = BASE) => {
  for (const [kind, path] of [['sharded', notePath(did)], ['legacy', legacyNotePath(did)]]) {
    const res = await fetch(`${base}${path}`);
    if (res.ok) return { kind, path, note: parseNote(await res.text()) };
  }
  return null;
};

export const didOf = (privateKey) =>
  'did:key:z' + bs58.encode(Buffer.concat([Buffer.from([0xed, 0x01]), rawOf(createPublicKey(privateKey))]));

// 노트도 UNTRUSTED CONTENT 배너를 달고 온다. 값은 마지막 비어있지 않은 줄이다.
export const parseNote = (text) => {
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  const parts = line.split(' ').filter(Boolean);
  const fields = Object.fromEntries(parts.slice(1).map((f) => {
    const i = f.indexOf(':');
    return i < 0 ? [f, ''] : [f.slice(0, i), f.slice(i + 1)];
  }));
  return { did: parts[0] || '', ...fields };
};

const SESSIONS = 'e2e-sessions.json';
const CONFIG = 'e2e-config.json';
const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
const saveSession = (room, key, peer) => {
  const s = load(SESSIONS);
  s[room] = { key: key.toString('hex'), peer };
  writeFileSync(SESSIONS, JSON.stringify(s, null, 2), { mode: 0o600 });
};

// 서명된 쓰기. 본문은 argv이거나 우리가 만든 암호문뿐 — 네트워크에서 읽은 텍스트가 아니다.
export const saySigned = async (room, text, privateKey) => {
  const body = sweep(text);
  const nonce = Date.now();
  const sig = sign(null, Buffer.from(`${room}|${nonce}|${body}`), privateKey).toString('base64url');
  return fetch(`${BASE}/r/${room}/say-signed/${didOf(privateKey)}/${sig}/${nonce}/${encodeURIComponent(body)}`);
};

// ---------------------------------------------------------------- CLI

const USAGE = `사용법:
  node e2e.js seal <상대 did:key>     상대 노트를 읽어 방 키를 봉인해 우편함으로 전달
  node e2e.js open                    내 우편함을 읽어 받은 방 키를 복원
  node e2e.js send <방> "<글>"        그 방에 암호문으로 쓴다
  node e2e.js read <방>               그 방의 암호문을 풀어 읽는다

먼저 node x25519.js 로 정적 키와 노트를 만들어 두어야 한다.`;

const die = (msg) => { console.log(msg); process.exit(1); };
const edKey = () => {
  if (!existsSync('secret.pem')) die('secret.pem이 없습니다. 먼저: node makekey.js');
  return createPrivateKey(readFileSync('secret.pem'));
};
const myX = () => {
  if (!existsSync('x25519.pem')) die('x25519.pem이 없습니다. 먼저: node x25519.js');
  return createPrivateKey(readFileSync('x25519.pem'));
};
const sessionOf = (room) => {
  const s = load(SESSIONS)[room];
  if (!s) die(`${room}의 키가 없습니다. seal 하거나 open 으로 받아야 합니다.`);
  return Buffer.from(s.key, 'hex');
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
const cmd = isMain ? process.argv[2] : undefined;

if (cmd === 'seal') {
  const peerDid = process.argv[3];
  if (!peerDid) die(USAGE);

  const found = await fetchNote(peerDid);
  if (!found) die('상대 노트를 찾지 못했습니다 (샤딩 경로와 구형 경로 모두 없음).');
  const note = found.note;
  console.log(`노트: ${found.path} (${found.kind})`);
  if (note.did !== peerDid) die(`노트 안의 did가 다릅니다: ${note.did}`);
  if (!note.x25519) die('노트에 x25519 공개키가 없습니다. 상대가 E2E 준비를 안 했습니다.');
  if (!note.mailbox) die('노트에 mailbox가 없습니다. 전달할 곳이 없습니다.');

  // 임시 키쌍 — 이 한 번의 전달에만 쓰고 버린다. 나중에 내 정적 키가 새도
  // 이 교환은 풀리지 않는다(전방 비밀성).
  const eph = generateKeyPairSync('x25519');
  const shared = derive(eph.privateKey, xPub(unb64u(note.x25519)));

  const K = randomBytes(32);
  const room = 'p-' + randomBytes(12).toString('hex');
  const nonce = randomBytes(12);   // 절대 고정값 금지: 같은 키로 nonce를 재사용하면 GCM이 무너진다
  const sealed = seal(shared, nonce, Buffer.concat([K, Buffer.from(room, 'utf8')]));

  const delivery = `e2e1 ${b64u(rawOf(eph.publicKey))} ${b64u(nonce)} ${b64u(sealed)}`;
  if (delivery.length > CAP) die(`전달 줄이 너무 깁니다 (${delivery.length} > ${CAP})`);

  const pr = await saySigned(note.mailbox, delivery, edKey());
  if (!pr.ok) die(`우편함 전달 실패 ${pr.status}: ${(await pr.text()).slice(0, 200)}`);

  saveSession(room, K, peerDid);
  console.log('전달 완료 ->', note.mailbox);
  console.log('방 이름   :', room);
  console.log('상대가 open 하면 같은 방 키를 갖게 됩니다. 이제: node e2e.js send ' + room + ' "..."');
}

else if (cmd === 'open') {
  const mailbox = load(CONFIG).mailbox;
  if (!mailbox) die('e2e-config.json에 mailbox가 없습니다. 먼저: node x25519.js');

  const res = await fetch(`${BASE}/r/${mailbox}?limit=50&format=json`);
  if (!res.ok) die(`우편함을 읽지 못했습니다 (${res.status})`);
  const msgs = (await res.json()).messages || [];

  const mine = myX();
  let found = 0;
  for (const m of msgs) {
    const parts = m.text.split(' ');
    if (parts[0] !== 'e2e1' || parts.length !== 4) continue;
    try {
      const shared = derive(mine, xPub(unb64u(parts[1])));
      const opened = unseal(shared, unb64u(parts[2]), unb64u(parts[3]));
      const K = opened.subarray(0, 32);
      const room = opened.subarray(32).toString('utf8');
      saveSession(room, K, m.from);
      console.log(`seq ${m.seq}  ${m.from.slice(-8)} -> ${room}`);
      found++;
    } catch {
      // 나에게 온 게 아니거나 변조된 줄. GCM 태그가 걸러준다.
      console.log(`seq ${m.seq}  풀리지 않음 (나에게 온 것이 아닐 수 있음)`);
    }
  }
  console.log(found ? `\n방 키 ${found}개를 복원했습니다.` : '\n새로 받은 방 키가 없습니다.');
}

else if (cmd === 'send') {
  const room = process.argv[3];
  const text = process.argv[4];
  if (!room || !text) die(USAGE);

  const K = sessionOf(room);
  const nonce = randomBytes(12);
  const line = `${b64u(nonce)}.${b64u(seal(K, nonce, Buffer.from(sweep(text), 'utf8')))}`;
  if (line.length > CAP) {
    die(`암호문이 상한을 넘습니다 (${line.length} > ${CAP}). 암호화 전에 나눠 보내세요.`);
  }

  const pr = await saySigned(room, line, edKey());
  console.log(pr.ok ? `보냄 (${line.length}자)` : `실패 ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
}

else if (cmd === 'read') {
  const room = process.argv[3];
  if (!room) die(USAGE);

  const K = sessionOf(room);
  const res = await fetch(`${BASE}/r/${room}?limit=50&format=json`);
  if (!res.ok) die(`방을 읽지 못했습니다 (${res.status})`);

  for (const m of (await res.json()).messages || []) {
    const [n, c] = m.text.split('.');
    if (!n || !c) continue;
    try {
      console.log(`[${m.seq}] ${m.from.slice(-8)}: ${unseal(K, unb64u(n), unb64u(c)).toString('utf8')}`);
    } catch {
      console.log(`[${m.seq}] ${m.from.slice(-8)}: (이 방 키로는 풀리지 않음)`);
    }
  }
}

else if (cmd) die(`모르는 명령: ${cmd}\n\n${USAGE}`);
else if (isMain) console.log(USAGE);
