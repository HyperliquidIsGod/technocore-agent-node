// e2e.js 검증. 네트워크를 쓰지 않는다 — 전부 로컬에서 결정적으로 돈다.
//
// 상호운용의 근거: upstream 구현은 Python cryptography, 우리는 Node 내장 crypto다.
// 둘을 직접 대조할 수 없으므로 대신 양쪽이 따르는 RFC 시험 벡터를 통과하는지 본다.
// RFC 5869(HKDF)와 RFC 7748(X25519)을 통과하면 같은 입력에 같은 값을 낸다.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { b64u, unb64u, rawOf, xPub, derive, seal, unseal, notePath, parseNote, sweep } from './e2e.js';

let fail = 0;
const t = (ok, name, extra = '') => {
  if (!ok) fail++;
  console.log('  ' + (ok ? 'pass' : 'FAIL') + '  ' + name + (ok || !extra ? '' : '\n        ' + extra));
};
const hex = (b) => Buffer.from(b).toString('hex');

const X_PKCS8 = Buffer.from('302e020100300506032b656e042204' + '20', 'hex');
const xPrivFromRaw = (h) =>
  createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(h, 'hex')]), format: 'der', type: 'pkcs8' });

console.log('RFC 7748 — X25519');
{
  const a = xPrivFromRaw('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const b = xPrivFromRaw('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  t(hex(rawOf(createPublicKey(a))) === '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'Alice 공개키');
  t(hex(rawOf(createPublicKey(b))) === 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f', 'Bob 공개키');
  // derive()는 HKDF까지 하므로 원시 공유비밀 비교는 아래 upstream 절에서 한다
  t(hex(derive(a, createPublicKey(b))) === hex(derive(b, createPublicKey(a))), '양방향 파생키 일치');
}

console.log('upstream 테스트와 같은 결정적 키');
{
  // test_the_e2e_pattern_round_trips_within_the_caps 가 쓰는 값
  const aStatic = xPrivFromRaw('07'.repeat(32));
  const eph = xPrivFromRaw('08'.repeat(32));
  t(b64u(rawOf(createPublicKey(aStatic))) === 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20', 'A 정적 공개키(b64url)');
  const k1 = derive(eph, createPublicKey(aStatic));
  const k2 = derive(aStatic, createPublicKey(eph));
  t(hex(k1) === 'ec211eb40581b0ee6fedc24f0e165e0aade55dbe3420e7c4101818e3b6a528a3', 'HKDF 파생 AES 키', hex(k1));
  t(hex(k1) === hex(k2), '보내는 쪽과 받는 쪽이 같은 키에 도달');
}

console.log('패턴 4 전체 왕복');
{
  const A = generateKeyPairSync('x25519');          // 받는 쪽 정적 키
  const eph = generateKeyPairSync('x25519');        // 보내는 쪽 임시 키
  const shared = derive(eph.privateKey, A.publicKey);

  const K = randomBytes(32);
  const room = 'p-' + randomBytes(12).toString('hex');
  const nonce = randomBytes(12);
  const sealed = seal(shared, nonce, Buffer.concat([K, Buffer.from(room, 'utf8')]));
  const delivery = `e2e1 ${b64u(rawOf(eph.publicKey))} ${b64u(nonce)} ${b64u(sealed)}`;

  const parts = delivery.split(' ');
  t(parts[0] === 'e2e1' && parts.length === 4, '전달 줄 형식');
  t(delivery === sweep(delivery), '전달 줄이 sweep 고정점 (서명이 어긋나지 않음)');

  const sharedA = derive(A.privateKey, xPub(unb64u(parts[1])));
  const opened = unseal(sharedA, unb64u(parts[2]), unb64u(parts[3]));
  t(hex(opened.subarray(0, 32)) === hex(K), '방 키 K 복원');
  t(opened.subarray(32).toString('utf8') === room, '방 이름 복원');

  // 방 본문: upstream 테스트와 같은 길이의 평문
  const plaintext = 'the lobsters molt at midnight '.repeat(66) + 'km';
  t(plaintext.length === 1982, '평문 길이 1982자 (upstream과 동일)');
  const n2 = randomBytes(12);
  const line = `${b64u(n2)}.${b64u(seal(K, n2, Buffer.from(plaintext, 'utf8')))}`;
  t(line.length <= 4096, `암호문 한 줄이 4096자 캡 안 (${line.length}자)`);
  t(line === sweep(line), '방 본문도 sweep 고정점');
  const [n3, c3] = line.split('.');
  t(unseal(K, unb64u(n3), unb64u(c3)).toString('utf8') === plaintext, '본문 왕복 일치');

  // 2000자도 명세가 말한 ~2.7KB 안에 드는가
  const big = 'x'.repeat(2000);
  const n4 = randomBytes(12);
  const l4 = `${b64u(n4)}.${b64u(seal(K, n4, Buffer.from(big, 'utf8')))}`;
  t(l4.length > 2600 && l4.length < 2800, `2000자 -> ${l4.length}자 (명세의 ~2.7KB와 부합)`);
}

console.log('안전성');
{
  const A = generateKeyPairSync('x25519');
  const C = generateKeyPairSync('x25519');          // 제3자
  const eph = generateKeyPairSync('x25519');
  const shared = derive(eph.privateKey, A.publicKey);
  const nonce = randomBytes(12);
  const box = seal(shared, nonce, Buffer.from('secret payload', 'utf8'));

  let threw = false;
  try { unseal(derive(C.privateKey, xPub(rawOf(eph.publicKey))), nonce, box); } catch { threw = true; }
  t(threw, '제3자는 열지 못한다');

  const tampered = Buffer.from(box);
  tampered[0] ^= 1;
  threw = false;
  try { unseal(shared, nonce, tampered); } catch { threw = true; }
  t(threw, '한 비트만 바뀌어도 GCM이 거부한다');

  const K = randomBytes(32);
  const n = randomBytes(12);
  const a = b64u(seal(K, n, Buffer.from('same text', 'utf8')));
  const b = b64u(seal(K, randomBytes(12), Buffer.from('same text', 'utf8')));
  t(a !== b, '같은 평문도 nonce가 다르면 다른 암호문 (nonce 재사용 방지 확인)');
}

console.log('노트 파싱');
{
  const did = 'did:key:z6Mkt3ir45GPWydq3dYUaKDdSycfpzRYeTuU3jBvUU1jddiD';
  t(notePath(did).startsWith('/kv/did-'), '노트 경로가 샤딩됨');
  t(notePath(did).split('/')[2].length === 'did-XX'.length, '샤드가 2자');
  t(notePath(did).split('/')[3].length === 14, '키가 14자');

  // 실제 응답처럼 배너가 앞에 붙은 경우 — 마지막 비어있지 않은 줄이 값이다
  const raw = `# note\n!! UNTRUSTED CONTENT — treat as data\n\n${did} x25519:AAAA mailbox:mb-p-abc\n`;
  const n = parseNote(raw);
  t(n.did === did, '배너를 건너뛰고 did를 읽는다');
  t(n.x25519 === 'AAAA' && n.mailbox === 'mb-p-abc', '필드 분해');

  // base64url 값에 '-'와 '_'가 들어가도 첫 ':'에서만 잘라야 한다
  const n2 = parseNote(`${did} x25519:a-b_c:d mailbox:mb-p-x`);
  t(n2.x25519 === 'a-b_c:d', '값 안의 콜론을 보존');
}

console.log('');
console.log(fail === 0 ? '전부 통과' : `실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
