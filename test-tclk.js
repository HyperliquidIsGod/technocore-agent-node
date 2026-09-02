// tclk.js 검증. 네트워크를 쓰지 않는다 — 전부 로컬에서 결정적으로 돈다.
//
// 상호운용의 근거: 참조 구현은 TypeScript(@flop-labs/tclk)이고 우리는 Node 내장 crypto다.
// 두 구현이 같은 계약 id 를 내지 않으면 두 당사자는 서로 다른 거래를 하고 있다고 믿게 되고,
// 서명은 그걸 잡아주지 않는다 — 각자 자기가 믿는 문장에 제대로 서명했기 때문이다.
// 그래서 참조 구현이 tests/vectors.test.ts 에 고정해 둔 골든 벡터를 여기 그대로 옮겨 대본다.
// 어긋나면 고칠 것은 구현이지 벡터가 아니다.
import {
  makeOffer, makeAccept, encodeFrame, decodeFrame, tryDecodeFrame, validateFrame,
  openContract, applyFrame, generateHashLock, generatePointLock, verifySecret,
  isValidPointStatement, dealRoom, stateNote, stateNoteValue, parseStateNoteValue,
  capabilityToken, parseCapabilityToken, canonicalJson, toAscii, MAX_FRAME_CHARS,
} from './tclk.js';

let fail = 0;
const t = (ok, name, extra = '') => {
  if (!ok) fail++;
  console.log('  ' + (ok ? 'pass' : 'FAIL') + '  ' + name + (ok || !extra ? '' : '\n        ' + extra));
};
const throws = (fn, name) => {
  try { fn(); t(false, name, '던지지 않았다'); }
  catch { t(true, name); }
};

const PAYER = 'did:key:z6Mk' + 'f'.repeat(44);
const PAYEE = 'did:key:z6Mk' + 'g'.repeat(44);

console.log('참조 구현의 골든 벡터');
{
  const OFFER_ID = '0xd001fbbf4fa36d9ab8ea88df02a8b3303539e9d59f7ff9d9bfeb679318e9ce75';
  const CONTRACT_ID = '0x2768bf32b455317879796093ff2e5882371cbec238611ca71f555a7fcbe58e1c';

  const OFFER_LINE =
    'tclk1 {"amount":"1000000","asset":"FLOP","claimByMs":1756703600000,"expiresMs":1756700600000,' +
    '"from":"did:key:z6Mkffffffffffffffffffffffffffffffffffffffffffff",' +
    `"id":"${OFFER_ID}",` +
    '"job":{"context":"ctx-1","id":"task-3f","proto":"a2a"},"lock":"hash",' +
    '"nonce":"9f2c81d04c9e1f7a","rails":["flop-htlc","x402"],"refundAfterMs":1756707200000,' +
    '"role":"payer","type":"offer"}';

  const ACCEPT_LINE =
    `tclk1 {"contract":"${CONTRACT_ID}",` +
    '"from":"did:key:z6Mkgggggggggggggggggggggggggggggggggggggggggggg",' +
    `"nonce":"0011223344556677","ref":"${OFFER_ID}",` +
    '"statement":"0xabababababababababababababababababababababababababababababababab",' +
    '"type":"accept"}';

  const offer = makeOffer({
    from: PAYER, role: 'payer', amount: '1000000', asset: 'FLOP', lock: 'hash',
    rails: ['flop-htlc', 'x402'], claimByMs: 1756703600000, refundAfterMs: 1756707200000,
    expiresMs: 1756700600000, job: { proto: 'a2a', id: 'task-3f', context: 'ctx-1' },
    nonce: '9f2c81d04c9e1f7a',
  });
  const accept = makeAccept(offer, { from: PAYEE, statement: '0x' + 'ab'.repeat(32), nonce: '0011223344556677' });

  t(offer.id === OFFER_ID, 'offer id', offer.id);
  t(encodeFrame(offer) === OFFER_LINE, 'offer 줄이 바이트까지 같다', encodeFrame(offer));
  t(accept.contract === CONTRACT_ID, '계약 id', accept.contract);
  t(encodeFrame(accept) === ACCEPT_LINE, 'accept 줄이 바이트까지 같다', encodeFrame(accept));
}

console.log('비ASCII 가 든 프레임의 id');
{
  // 이 벡터가 잡는 것 하나: id 를 탈출 전 문자열에서 해싱하는 구현. ASCII 프레임에서는
  // 두 방식이 같은 값을 내서 절대 드러나지 않다가, 비ASCII 한 글자에서 갈라진다.
  const NON_ASCII_OFFER_ID = '0xfdad69c602bef151596e3e914cc3ca05b1ccd009211b57c4fdbf0ba0e0d4635b';
  const offer = makeOffer({
    from: PAYER, role: 'payer', lock: 'hash', amount: '100', asset: 'FLOP',
    rails: ['flop-htlc'], claimByMs: 1756703600000, refundAfterMs: 1756707200000,
    expiresMs: 1756700600000, job: { proto: 'a2a', id: 't' + String.fromCharCode(0xe2) + 'che-1' },
    nonce: '9f2c81d04c9e1f7a',
  });
  const line = encodeFrame(offer);
  t(/^[\x20-\x7e]*$/.test(line), '줄이 출력 가능한 ASCII 뿐이다');
  t(line.includes('\\u00e2'), '비ASCII 가 \\uXXXX 로 나갔다');
  t(offer.id === NON_ASCII_OFFER_ID, 'id 는 탈출한 바이트를 해싱한다', offer.id);
}

console.log('정규 직렬화');
{
  t(canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}', '키를 정렬한다');
  t(canonicalJson({ a: undefined, b: 1 }) === '{"b":1}', 'undefined 를 버린다');
  t(canonicalJson({ a: [3, { d: 1, c: 2 }] }) === '{"a":[3,{"c":2,"d":1}]}', '중첩까지 내려간다');
  t(toAscii('a' + String.fromCharCode(0x80)) === 'a\\u0080', 'C1 시작점도 탈출한다');
}

console.log('닫히는 검증');
{
  const base = {
    from: PAYER, role: 'payer', amount: '1000000', asset: 'FLOP', lock: 'hash', rails: ['flop-htlc'],
    claimByMs: 2000, refundAfterMs: 3000, expiresMs: 1000, nonce: '9f2c81d04c9e1f7a',
  };
  throws(() => makeOffer({ ...base, claimByMs: 3000 }), '청구 마감이 환불 개시와 붙으면 거절');
  throws(() => makeOffer({ ...base, amount: '0' }), '금액 0 거절');
  throws(() => makeOffer({ ...base, amount: '1.5' }), '소수 금액 거절');
  throws(() => makeOffer({ ...base, rails: [] }), '레일 없는 offer 거절');
  throws(() => makeOffer({ ...base, from: 'did:key:z6Mkshort' }), '형식 틀린 DID 거절');
  throws(() => makeOffer({ ...base, lock: 'point' }), 'point 잠금인데 paymentKey 없으면 거절');
  throws(() => validateFrame({ ...makeOffer(base), extra: 1 }), '모르는 필드 거절');
  throws(() => validateFrame({ ...makeOffer(base), amount: '999' }), '내용을 고치면 id 가 어긋나 거절');

  const offer = makeOffer(base);
  throws(() => makeAccept(offer, { from: PAYER, statement: '0x' + 'ab'.repeat(32) }), '자기 offer 를 자기가 받으면 거절');
  throws(() => makeAccept(offer, { from: PAYEE, statement: '0x' + 'ab'.repeat(33) }), 'hash 잠금에 33바이트 진술 거절');

  t(tryDecodeFrame('그냥 대화') === null, 'tclk 아닌 줄은 null');
  t(tryDecodeFrame('tclk1 {망가진') === null, '망가진 tclk 줄도 null — 읽는 쪽이 멈추면 안 된다');
  t(tryDecodeFrame('tclk1 {"type":"reveal","from":"' + PAYER + '","contract":"0x' + '11'.repeat(32) + '","secret":"짧다"}') === null,
    '형식 틀린 비밀 거절');
  t(decodeFrame(encodeFrame(offer)).id === offer.id, '왕복');
}

console.log('잠금');
{
  const { preimage, statement } = generateHashLock();
  t(verifySecret('hash', statement, preimage), '해시 잠금 왕복');
  t(!verifySecret('hash', statement, '0x' + '00'.repeat(32)), '틀린 원상 거절');
  const { witness, statement: Y } = generatePointLock();
  t(isValidPointStatement(Y), '점 진술이 곡선 위에 있다');
  t(verifySecret('point', Y, witness), '점 잠금 왕복');
  t(!verifySecret('point', Y, '0x' + '01'.repeat(32)), '틀린 증인 거절');
  // 길이만 맞고 곡선 밖인 점 — 길이 검사만 하는 구현이 통과시키는 그 값
  t(!isValidPointStatement('0x02' + 'ff'.repeat(32)), '곡선 밖의 점 거절');
}

console.log('상태기계');
{
  const now = Date.now();
  const mk = (role, from) => makeOffer({ from, role, amount: '100', asset: 'FLOP', lock: 'hash',
    rails: ['flop-htlc'], claimByMs: now + 3600000, refundAfterMs: now + 7200000, expiresMs: now + 600000 });

  const offer = mk('payer', PAYER);
  const { preimage, statement } = generateHashLock();
  const accept = makeAccept(offer, { from: PAYEE, statement });
  const lock = { type: 'lock', from: PAYER, contract: accept.contract, rail: 'flop-htlc', ref: 'escrow-1' };
  const reveal = { type: 'reveal', from: PAYEE, contract: accept.contract, secret: preimage };

  let s = openContract(offer);
  t(s.status === 'proposed', '열면 proposed');
  s = applyFrame(s, accept, now).state;
  t(s.status === 'accepted' && s.payeeDid === PAYEE, 'accept 가 수취인을 정한다');
  t(!applyFrame(s, accept, now).ok, '같은 accept 를 다시 먹여도 움직이지 않는다');
  t(!applyFrame(s, { ...lock, rail: 'x402' }, now).ok, 'offer 에 없던 레일 거절');
  t(!applyFrame(s, { ...lock, from: PAYEE }, now).ok, '수취인은 잠글 수 없다');
  s = applyFrame(s, lock, now).state;
  t(s.status === 'locked' && s.railRef === 'escrow-1', 'lock 이 레일 참조를 남긴다');
  t(!applyFrame(s, { type: 'refund', from: PAYER, contract: accept.contract }, now).ok, '환불 창 전의 refund 거절');
  t(applyFrame(s, { type: 'refund', from: PAYER, contract: accept.contract }, now + 7200001).ok, '환불 창 뒤의 refund 수락');
  t(!applyFrame(s, reveal, now + 7200001).ok, '환불 창이 열린 뒤의 reveal 거절');
  s = applyFrame(s, reveal, now).state;
  t(s.status === 'claimed' && s.secret === preimage, 'reveal 이 청구다');
  t(!applyFrame(s, { type: 'cancel', from: PAYER, contract: accept.contract }, now).ok, '종결 뒤의 cancel 거절');
  t(applyFrame(s, { type: 'receipt', from: PAYEE, contract: accept.contract, outcome: 'claimed' }, now).ok, 'receipt 수락');
  t(!applyFrame(s, { type: 'receipt', from: PAYEE, contract: accept.contract, outcome: 'refunded' }, now).ok,
    '결과가 다른 receipt 거절');

  // 만료된 offer, 그리고 당사자가 아닌 쪽
  let e = openContract(offer);
  t(!applyFrame(e, accept, now + 600001).ok, '만료된 offer 는 받을 수 없다');
  const STRANGER = 'did:key:z6Mk' + 'h'.repeat(44);
  t(!applyFrame(e, { type: 'cancel', from: STRANGER, contract: accept.contract }, now).ok, '당사자 아닌 쪽의 cancel 거절');

  // 받는 쪽이 먼저 연 offer — 역할이 뒤집힌다
  const offerB = mk('payee', PAYEE);
  const acceptB = makeAccept(offerB, { from: PAYER, statement });
  const sb = applyFrame(openContract(offerB), acceptB, now).state;
  t(sb.payerDid === PAYER && sb.payeeDid === PAYEE, 'payee 가 연 offer 도 역할이 맞게 붙는다');

  // 절대 던지지 않는다: 세상에 열린 방의 아무 줄이나 먹여도
  const junk = [null, {}, { type: 'nope' }, { type: 'lock' }, 42, 'tclk1 {}'];
  let threw = false;
  for (const j of junk) { try { applyFrame(s, j, now); } catch { threw = true; } }
  t(!threw, '쓰레기 입력에도 던지지 않는다');
}

console.log('방과 노트 이름');
{
  const c = '0x' + '3f9c0a1d7e2b4c56' + '0'.repeat(48);
  t(dealRoom(c) === 'mb-p-tclk-3f9c0a1d7e2b4c56', '거래방 이름');
  t(dealRoom(c).length <= 48 && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(dealRoom(c)), '방 이름 문법에 맞는다');
  const n = stateNote(c);
  t(n.ns === 'tclk-3f' && n.key === '9c0a1d7e2b4c56', '상태 노트 경로가 샤딩된다');
  t(stateNoteValue('locked', 'escrow-1') === 'locked escrow-1', '상태 노트 값');
  t(parseStateNoteValue('locked escrow-1').railRef === 'escrow-1', '상태 노트 값 되읽기');
  t(parseStateNoteValue('아무거나') === null, '모르는 상태는 null — 그 네임스페이스는 누구나 쓴다');
  t(parseStateNoteValue('locked a b') === null, '토큰이 더 붙으면 null');
  t(capabilityToken(['flop-htlc', 'x402']) === 'tclk1:flop-htlc,x402', '능력 토큰');
  t(String(parseCapabilityToken('did:key:z6Mk… mailbox:mb-p-x tclk1:flop-htlc,x402')) === 'flop-htlc,x402',
    'DID 노트에서 능력 토큰 읽기');
  t(parseCapabilityToken('did:key:z6Mk… mailbox:mb-p-x') === null, '토큰이 없으면 null');
}

console.log('방 상한');
{
  const now = Date.now();
  const long = makeOffer({ from: PAYER, role: 'payer', amount: '1', asset: 'FLOP', lock: 'hash',
    rails: ['flop-htlc'], claimByMs: now + 1000, refundAfterMs: now + 2000, expiresMs: now + 500,
    job: { proto: 'a2a', id: 'x'.repeat(4200) } });
  throws(() => encodeFrame(long), `${MAX_FRAME_CHARS}자 상한을 넘으면 내보내지 않는다`);
  const swept = makeOffer({ from: PAYER, role: 'payer', amount: '1', asset: 'FLOP', lock: 'hash',
    rails: ['flop-htlc'], claimByMs: now + 1000, refundAfterMs: now + 2000, expiresMs: now + 500,
    job: { proto: 'a2a', id: 'a' + String.fromCharCode(0x7f) + 'b' } });
  // DEL(0x7F)은 ASCII 범위 안이라 toAscii 가 건드리지 않는다. 서버가 공백으로
  // 그대로 내보내면 읽는 쪽이 재검증할 바이트가 달라지므로 여기서 막는다.
  throws(() => encodeFrame(swept), '서버가 쓸어버릴 문자가 있으면 내보내지 않는다');
}

console.log('');
console.log(fail === 0 ? '전부 통과' : `${fail}건 실패`);
process.exit(fail === 0 ? 0 : 1);
