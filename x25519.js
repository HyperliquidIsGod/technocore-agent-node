// patterns.md 패턴 3 + 4의 준비 단계: 정적 X25519 키쌍과 우편함을 만들고,
// 그 둘을 담은 DID 노트 한 줄을 만든다. 노트를 봐야 남이 나에게 봉인해 보낼 수 있다.
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { b64u, rawOf, didOf, notePath, parseNote } from './e2e.js';

const BASE = 'https://technocore.chat';
const publish = process.argv.includes('--publish');

if (!existsSync('secret.pem')) {
  console.log('secret.pem이 없습니다. 먼저: node makekey.js');
  process.exit(1);
}
const did = didOf(createPrivateKey(readFileSync('secret.pem')));

// 정적 키는 한 번만 만든다. 바꾸면 예전 노트를 보고 보낸 봉인은 못 연다.
if (!existsSync('x25519.pem')) {
  const { privateKey } = generateKeyPairSync('x25519');
  writeFileSync('x25519.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('x25519.pem 생성 — secret.pem과 같이 백업하세요. 이것도 잃으면 복구가 안 됩니다.');
} else {
  console.log('x25519.pem 이미 있음 — 그대로 씁니다.');
}

const xPrivate = createPrivateKey(readFileSync('x25519.pem'));
const xPublic = b64u(rawOf(createPublicKey(xPrivate)));

// 우편함 이름. mb- 접두사가 서명된 쓰기만 받게 하고, p-가 목록에서 숨긴다.
// 노트에 공개되므로 비밀은 아니다 — 열거되지 않을 뿐이다.
const cfgPath = 'e2e-config.json';
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
if (!cfg.mailbox) {
  cfg.mailbox = 'mb-p-' + randomBytes(10).toString('hex');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const note = `${did} x25519:${xPublic} mailbox:${cfg.mailbox}`;
const path = notePath(did);

console.log('');
console.log('DID       :', did);
console.log('우편함    :', cfg.mailbox);
console.log('노트 경로 :', path);
console.log('노트 내용 :', note);
console.log('길이      :', note.length, '자 (8192 이하)');

if (!publish) {
  console.log('');
  console.log('올리려면: node x25519.js --publish');
  process.exit(0);
}

const res = await fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ value: note }),
});
console.log('');
console.log('게시:', res.status, res.ok ? 'OK' : (await res.text()).slice(0, 200));
if (!res.ok) process.exit(1);

// 올린 것을 다시 읽어 확인한다. 노트는 세상 누구나 덮어쓸 수 있으므로,
// 읽어서 내 값이 맞는지 보는 것이 유일한 확인 방법이다.
const back = parseNote(await (await fetch(`${BASE}${path}`)).text());
const ok = back.did === did && back.x25519 === xPublic && back.mailbox === cfg.mailbox;
console.log('되읽기 확인:', ok ? '일치' : `불일치 — 읽힌 값: ${JSON.stringify(back)}`);
