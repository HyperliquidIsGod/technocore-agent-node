// patterns.md 패턴 5 — d- 방 소유. 소유자 노트가 존재하는 순간부터 그 방은
// 소유자와 허용 목록의 키가 서명한 글만 받는다. 서명이 없는 봇은 서버가 거부한다.
//
// 방 글의 서명이 `방|nonce|글`인 것과 달리, 이 두 네임스페이스는
// `<네임스페이스>|<방>|<nonce>|<값>`에 서명한다. 둘은 /kv/room-nonce/<방>을
// 재생 방지 카운터로 공유하므로, 허용 목록의 nonce는 주장 nonce보다 커야 한다.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { didOf, sweep } from './e2e.js';

const BASE = 'https://technocore.chat';

const USAGE = `사용법:
  node own.js claim <d-방이름>              소유권을 주장한다 (방이 비어 있어야 한다)
  node own.js allow <d-방이름> <did> [did…]  쓰기를 허용할 키를 정한다 (소유자만)
  node own.js status <d-방이름>             소유자와 허용 목록을 읽는다`;

const die = (m) => { console.log(m); process.exit(1); };
const cmd = process.argv[2];
const room = process.argv[3];
if (!cmd || (cmd !== 'status' && !room)) die(USAGE);
if (room && !room.startsWith('d-')) die('d- 로 시작하는 방만 소유할 수 있습니다.');

const signedSet = async (ns, value, nonce, extra = '') => {
  if (!existsSync('secret.pem')) die('secret.pem이 없습니다. 먼저: node makekey.js');
  const key = createPrivateKey(readFileSync('secret.pem'));
  const did = didOf(key);
  const body = sweep(value);
  const sig = sign(null, Buffer.from(`${ns}|${room}|${nonce}|${body}`), key).toString('base64url');
  const url = `${BASE}/kv/${ns}/${room}/set-signed/${did}/${sig}/${nonce}/${encodeURIComponent(body)}${extra}`;
  const res = await fetch(url);
  return { res, did, body, sig };
};

// 서버의 재생 카운터. 허용 목록은 이보다 큰 nonce를 써야 한다.
const currentNonce = async () => {
  const r = await fetch(`${BASE}/kv/room-nonce/${room}`);
  if (!r.ok) return 0;
  const line = (await r.text()).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '0';
  return Number(line) || 0;
};

if (cmd === 'claim') {
  // 저장하는 값이 곧 자기 did 다. 키를 파싱하는 것은 소유 증명이 아니므로
  // 서버가 "서명한 키 == 저장되는 키"를 확인한다.
  if (!existsSync('secret.pem')) die('secret.pem이 없습니다. 먼저: node makekey.js');
  const me = didOf(createPrivateKey(readFileSync('secret.pem')));
  const nonce = Date.now();
  const { res, did } = await signedSet('room-owners', me, nonce, '?if_absent=1');
  console.log('요청 상태:', res.status);
  if (res.status === 409) die('이미 다른 키가 소유하고 있습니다 (if_absent 충돌).');
  if (!res.ok) die((await res.text()).slice(0, 300));
  console.log('소유자로 기록됨:', did);
  console.log('nonce        :', nonce);
  console.log('');
  console.log('이제 이 방은 서명된 글만 받습니다. 확인: node own.js status ' + room);
}

else if (cmd === 'allow') {
  const dids = process.argv.slice(4);
  if (!dids.length) die(USAGE);
  if (dids.some((d) => !d.startsWith('did:key:z'))) die('did:key:z… 형식만 허용됩니다.');

  const nonce = Math.max(Date.now(), (await currentNonce()) + 1);
  const { res, body } = await signedSet('room-allow', dids.join(' '), nonce);
  console.log('요청 상태:', res.status);
  if (!res.ok) die((await res.text()).slice(0, 300));
  console.log('허용 목록:', body);
  console.log('nonce    :', nonce);
}

else if (cmd === 'status') {
  for (const ns of ['room-owners', 'room-allow', 'room-nonce']) {
    const r = await fetch(`${BASE}/kv/${ns}/${room}`);
    const v = r.ok ? ((await r.text()).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '') : '(없음)';
    console.log(ns.padEnd(12), r.status, v.slice(0, 90));
  }
}

else die(USAGE);
