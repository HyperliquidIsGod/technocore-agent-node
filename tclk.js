// patterns.md 패턴 6 — tclk/1. 두 에이전트가 방에서 만나 거래를 맞추는 규약이다.
//
// 규격 원본은 https://github.com/flop-labs/tclk 의 SPEC.md 이고 참조 구현은 그 저장소의
// TypeScript src/ 다. 이 파일은 그것을 옮긴 게 아니라 독립 구현이다. 목적은 하나다:
// 서로 다른 두 구현이 같은 계약 id 를 내는지 확인하는 것. 계약 id 가 어긋나면 두 당사자는
// 서로 다른 거래를 하고 있다고 믿게 되고, 그건 서명으로도 잡히지 않는다. test-tclk.js 가
// 참조 구현이 고정해 둔 골든 벡터에 이 구현을 그대로 대본다.
//
// 돈은 이 파일을 지나가지 않는다. 방은 "무엇을 합의했고 누가 말했는가"의 기록이고,
// 값은 offer 가 지명한 정산 레일이 쥔다. 여기서 서명이 통과했다는 건 그 문장을 그 키가
// 썼다는 뜻일 뿐, 잠금이 실제로 걸렸다는 뜻이 아니다 — 규격 5단계가 그래서 "일하기 전에
// 레일을 직접 확인하라"고 못박는다.
import { createHash, randomBytes, createECDH, ECDH, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fetchRecords, verifyRecord } from './verify.js';

const BASE = 'https://technocore.chat';
export const PREFIX = 'tclk1 ';
export const DOMAIN = 'FLOP::tclk::v1';
export const MAX_FRAME_CHARS = 4096;
export const OFFER_ROOM = 'tclk-offers';

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX33 = /^0x[0-9a-f]{66}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const AMOUNT = /^[1-9][0-9]*$/;
const ASSET = /^[A-Za-z0-9_-]{1,32}$/;
const RAIL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NONCE = /^[0-9a-f]{8,64}$/;
const SCALAR = /^0x[0-9a-f]{1,64}$/;
const STATUSES = ['proposed', 'accepted', 'locked', 'claimed', 'refunded', 'cancelled'];

const fail = (msg) => { throw new Error('tclk: ' + msg); };
const hexToBuf = (h) => Buffer.from(h.slice(2), 'hex');
const bufToHex = (b) => '0x' + Buffer.from(b).toString('hex');

// ── 정규 직렬화 ──────────────────────────────────────────────────────────────
// 키를 정렬하고, 공백을 넣지 않고, undefined 를 버린다. 두 구현이 같은 바이트에
// 도달해야 같은 id 가 나온다.
export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    if (s === undefined) fail('프레임에 직렬화할 수 없는 값이 있다');
    return s;
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    .join(',') + '}';
};

// 비ASCII를 전부 \uXXXX 로 뺀다. 서버가 보이지 않는 문자를 공백으로 쓸어버리기 때문에,
// 저장된 바이트와 서명한 바이트를 같게 만드는 방법은 ASCII 로 내려가는 것뿐이다.
// 정규식을 문자열로 조립하는 이유는 소스에 그 문자들을 직접 넣지 않기 위해서다.
const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g');
export const toAscii = (json) =>
  json.replace(NON_ASCII, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

// id 는 탈출한 뒤의 문자열을 해싱한다. 탈출 전 문자열을 해싱하면 비ASCII 한 글자만 들어가도
// 두 구현의 계약 id 가 갈라진다. ASCII 프레임에서는 둘이 같아서 티가 안 나고, 그래서 더 위험하다.
const domainHash = (tag, payload) =>
  bufToHex(createHash('sha256').update(`${DOMAIN}|${tag}|${toAscii(payload)}`).digest());

export const offerId = (fields) => domainHash('offer', canonicalJson(fields));
export const contractId = (offer, accept) => domainHash('contract', canonicalJson({ offer, accept }));

// ── 프레임 검증: 막히면 닫는다 ───────────────────────────────────────────────
const KEYS = {
  offer: {
    allowed: ['type', 'from', 'role', 'amount', 'asset', 'lock', 'rails', 'claimByMs',
      'refundAfterMs', 'expiresMs', 'paymentKey', 'job', 'nonce', 'id'],
    required: ['from', 'role', 'amount', 'asset', 'lock', 'rails', 'claimByMs',
      'refundAfterMs', 'expiresMs', 'nonce', 'id'],
  },
  accept: { allowed: ['type', 'from', 'ref', 'statement', 'contract', 'paymentKey', 'nonce'],
            required: ['from', 'ref', 'statement', 'contract', 'nonce'] },
  lock:   { allowed: ['type', 'from', 'contract', 'rail', 'ref', 'presig'],
            required: ['from', 'contract', 'rail', 'ref'] },
  reveal: { allowed: ['type', 'from', 'contract', 'secret'], required: ['from', 'contract', 'secret'] },
  refund: { allowed: ['type', 'from', 'contract', 'reason'], required: ['from', 'contract'] },
  cancel: { allowed: ['type', 'from', 'contract', 'reason'], required: ['from', 'contract'] },
  receipt:{ allowed: ['type', 'from', 'contract', 'outcome', 'rail', 'ref'],
            required: ['from', 'contract', 'outcome'] },
};

const str = (v, name, re) => {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} 은 비어있지 않은 문자열이어야 한다`);
  if (re && !re.test(v)) fail(`${name} 형식이 틀렸다: ${v}`);
  return v;
};
const ms = (v, name) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) fail(`${name} 은 양의 unix-ms 정수여야 한다`);
  return v;
};
const keys = (rec, allowed, required) => {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) fail(`${rec.type} 에 모르는 필드: ${k}`);
  for (const k of required) if (rec[k] === undefined) fail(`${rec.type} 에 빠진 필드: ${k}`);
};

// secp256k1 점이 실제로 곡선 위에 있는지 본다. 길이만 재는 검사는 검사가 아니다.
export const isValidPointStatement = (hex) => {
  if (!HEX33.test(hex)) return false;
  try { ECDH.convertKey(hex.slice(2), 'secp256k1', 'hex', 'hex', 'compressed'); return true; }
  catch { return false; }
};
const paymentKey = (v, name) => {
  const k = str(v, name, HEX33);
  if (!isValidPointStatement(k)) fail(`${name} 은 곡선 위의 점이 아니다`);
  return k;
};
const validateJob = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('job 은 객체여야 한다');
  keys({ ...v, type: 'job' }, new Set(['type', 'proto', 'id', 'context']), ['proto', 'id']);
  str(v.proto, 'job.proto', /^[a-z0-9][a-z0-9._-]{0,31}$/);
  str(v.id, 'job.id');
  if (v.context !== undefined) str(v.context, 'job.context');
  return v;
};

export const isValidStatement = (lock, statement) =>
  lock === 'hash' ? HEX32.test(statement) : isValidPointStatement(statement);

export const validateFrame = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('프레임은 객체여야 한다');
  const f = value;
  const spec = KEYS[f.type];
  if (!spec) fail(`모르는 프레임 종류: ${f.type}`);
  keys(f, new Set(spec.allowed), spec.required);
  str(f.from, 'from', DID_RE);

  if (f.type === 'offer') {
    if (f.role !== 'payer' && f.role !== 'payee') fail('role 은 payer|payee 여야 한다');
    str(f.amount, 'amount', AMOUNT);
    str(f.asset, 'asset', ASSET);
    if (f.lock !== 'hash' && f.lock !== 'point') fail('lock 은 hash|point 여야 한다');
    if (!Array.isArray(f.rails) || f.rails.length === 0) fail('rails 는 비어있지 않은 배열이어야 한다');
    for (const r of f.rails) str(r, 'rail', RAIL);
    const claimBy = ms(f.claimByMs, 'claimByMs');
    const refundAfter = ms(f.refundAfterMs, 'refundAfterMs');
    ms(f.expiresMs, 'expiresMs');
    // 청구 마감과 환불 개시 사이의 간격이 받는 쪽의 안전 창이다. 붙어 있으면 안전 창이 없다.
    if (claimBy >= refundAfter) fail('claimByMs 는 refundAfterMs 보다 엄격히 앞서야 한다');
    if (f.paymentKey !== undefined) paymentKey(f.paymentKey, 'paymentKey');
    if (f.lock === 'point' && f.paymentKey === undefined) fail('point 잠금에는 paymentKey 가 필요하다');
    if (f.job !== undefined) validateJob(f.job);
    str(f.nonce, 'nonce', NONCE);
    const { id: _drop, ...fields } = f;
    const expected = offerId(fields);
    if (f.id !== expected) fail(`offer id 불일치 (기대값 ${expected})`);
  } else if (f.type === 'accept') {
    str(f.ref, 'ref', HEX32);
    str(f.statement, 'statement', /^0x(?:[0-9a-f]{64}|[0-9a-f]{66})$/);
    str(f.contract, 'contract', HEX32);
    if (f.paymentKey !== undefined) paymentKey(f.paymentKey, 'paymentKey');
    str(f.nonce, 'nonce', NONCE);
  } else if (f.type === 'lock') {
    str(f.contract, 'contract', HEX32);
    str(f.rail, 'rail', RAIL);
    str(f.ref, 'ref');
    if (f.presig !== undefined) {
      const p = f.presig;
      if (!p || typeof p !== 'object' || Array.isArray(p)) fail('presig 는 객체여야 한다');
      keys({ ...p, type: 'presig' }, new Set(['type', 'nonce', 's']), ['nonce', 's']);
      str(p.nonce, 'presig.nonce', HEX33);
      str(p.s, 'presig.s', SCALAR);
    }
  } else if (f.type === 'reveal') {
    str(f.contract, 'contract', HEX32);
    str(f.secret, 'secret', HEX32);
  } else if (f.type === 'refund' || f.type === 'cancel') {
    str(f.contract, 'contract', HEX32);
    if (f.reason !== undefined) str(f.reason, 'reason');
  } else if (f.type === 'receipt') {
    str(f.contract, 'contract', HEX32);
    if (!['claimed', 'refunded', 'cancelled'].includes(f.outcome)) fail('outcome 이 잘못됐다');
    if (f.rail !== undefined) str(f.rail, 'rail', RAIL);
    if (f.ref !== undefined) str(f.ref, 'ref');
  }
  return f;
};

// ── 만들기 ───────────────────────────────────────────────────────────────────
export const makeOffer = (fields) => {
  const body = { ...fields, type: 'offer', nonce: fields.nonce ?? randomBytes(8).toString('hex') };
  return validateFrame({ ...body, id: offerId(body) });
};

export const makeAccept = (offer, accept) => {
  validateFrame(offer);
  if (accept.from === offer.from) fail('자기 offer 는 자기가 받을 수 없다');
  if (!isValidStatement(offer.lock, accept.statement)) fail(`statement 가 ${offer.lock} 잠금에 맞지 않는다`);
  if (offer.lock === 'point' && accept.paymentKey === undefined) fail('point 잠금에는 받는 쪽 paymentKey 가 필요하다');
  const core = {
    from: accept.from, ref: offer.id, statement: accept.statement,
    paymentKey: accept.paymentKey, nonce: accept.nonce ?? randomBytes(8).toString('hex'),
  };
  return validateFrame({ type: 'accept', ...core, contract: contractId(offer, core) });
};

// ── 줄 코덱 ──────────────────────────────────────────────────────────────────
export const isTclkLine = (text) => text.startsWith(PREFIX);

export const encodeFrame = (frame) => {
  const line = PREFIX + toAscii(canonicalJson(validateFrame(frame)));
  if (line.length > MAX_FRAME_CHARS) fail(`프레임이 ${MAX_FRAME_CHARS}자 상한을 넘었다 (${line.length})`);
  // 서버는 저장 전에 보이지 않는 문자를 공백으로 바꾼다. 그러면 읽는 쪽이 재검증할 바이트가
  // 조용히 달라지므로, 애초에 내보내지 않는다.
  if (!/^[\x20-\x7e]*$/.test(line)) fail('프레임 줄에 출력 가능한 ASCII 가 아닌 문자가 있다');
  return line;
};

export const decodeFrame = (text) => {
  if (!isTclkLine(text)) fail('tclk/1 줄이 아니다');
  let parsed;
  try { parsed = JSON.parse(text.slice(PREFIX.length)); } catch { fail('프레임이 올바른 JSON 이 아니다'); }
  return validateFrame(parsed);
};

// 방을 훑는 고리용. tclk 가 아닌 줄도, 망가진 tclk 줄도 null 이다 — 방의 본문은
// 익명 입력이고, 적대적인 한 줄이 읽는 쪽을 멈춰 세우면 안 된다.
export const tryDecodeFrame = (text) => { try { return decodeFrame(text); } catch { return null; } };

// ── 잠금 ─────────────────────────────────────────────────────────────────────
// 받는 쪽이 비밀을 만들고 진술만 공개한다. 나중에 비밀을 공개하는 행위 자체가 청구다.
export const generateHashLock = () => {
  const preimage = randomBytes(32);
  return { preimage: bufToHex(preimage), statement: bufToHex(createHash('sha256').update(preimage).digest()) };
};

export const pointFromScalar = (scalar) => {
  const ec = createECDH('secp256k1');
  ec.setPrivateKey(hexToBuf(scalar));
  return '0x' + ec.getPublicKey('hex', 'compressed');
};

export const generatePointLock = () => {
  const ec = createECDH('secp256k1');
  ec.generateKeys();
  return { witness: bufToHex(ec.getPrivateKey()), statement: '0x' + ec.getPublicKey('hex', 'compressed') };
};

// 비밀이 진술을 여는가. 전부 로컬 계산이고 네트워크도 신뢰도 필요 없다.
export const verifySecret = (lock, statement, secret) => {
  try {
    if (!HEX32.test(secret)) return false;
    if (lock === 'hash') return bufToHex(createHash('sha256').update(hexToBuf(secret)).digest()) === statement;
    return pointFromScalar(secret) === statement;
  } catch { return false; }
};

// ── 상태기계 ─────────────────────────────────────────────────────────────────
export const TERMINAL = new Set(['claimed', 'refunded', 'cancelled']);

export const openContract = (offer) => {
  validateFrame(offer);
  return {
    status: 'proposed', offer,
    payerDid: offer.role === 'payer' ? offer.from : undefined,
    payeeDid: offer.role === 'payee' ? offer.from : undefined,
    payerKey: offer.role === 'payer' ? offer.paymentKey : undefined,
    payeeKey: offer.role === 'payee' ? offer.paymentKey : undefined,
  };
};

const reject = (state, reason) => ({ state, ok: false, reason });
const isParty = (s, did) => did === s.offer.from || did === s.payerDid || did === s.payeeDid;

// 한 프레임을 적용한다. 절대 던지지 않는다 — 세상에 열린 방의 모든 줄을 그대로 먹여도
// 되도록. 잘못된 프레임은 상태를 그대로 둔 채 이유를 돌려준다.
export const applyFrame = (state, frame, nowMs) => {
  try { validateFrame(frame); }
  catch (e) { return reject(state, e.message); }

  switch (frame.type) {
    case 'offer':
      return reject(state, '이미 열린 계약이다');

    case 'accept': {
      if (state.status !== 'proposed') return reject(state, `${state.status} 상태에서 accept`);
      if (frame.ref !== state.offer.id) return reject(state, 'accept.ref 가 다른 offer 를 가리킨다');
      if (frame.from === state.offer.from) return reject(state, '자기 offer 는 자기가 받을 수 없다');
      if (nowMs >= state.offer.expiresMs) return reject(state, 'offer 가 만료됐다');
      const expected = contractId(state.offer, {
        from: frame.from, ref: frame.ref, statement: frame.statement,
        paymentKey: frame.paymentKey, nonce: frame.nonce,
      });
      if (frame.contract !== expected) return reject(state, '계약 id 불일치');
      if (state.offer.lock === 'point' && frame.paymentKey === undefined) {
        return reject(state, 'point 잠금에는 받는 쪽 paymentKey 가 필요하다');
      }
      // 손으로 만든 accept 가 32바이트짜리를 point 로 밀어 넣지 못하게 여기서 다시 본다.
      if (!isValidStatement(state.offer.lock, frame.statement)) {
        return reject(state, `statement 가 ${state.offer.lock} 잠금에 맞지 않는다`);
      }
      const acceptorIsPayer = state.offer.role === 'payee';
      return { ok: true, state: { ...state, status: 'accepted',
        contract: frame.contract, statement: frame.statement,
        payerDid: acceptorIsPayer ? frame.from : state.payerDid,
        payeeDid: acceptorIsPayer ? state.payeeDid : frame.from,
        payerKey: acceptorIsPayer ? frame.paymentKey : state.payerKey,
        payeeKey: acceptorIsPayer ? state.payeeKey : frame.paymentKey } };
    }

    case 'lock': {
      if (state.status !== 'accepted') return reject(state, `${state.status} 상태에서 lock`);
      if (frame.contract !== state.contract) return reject(state, 'lock 이 다른 계약을 가리킨다');
      if (frame.from !== state.payerDid) return reject(state, '잠그는 쪽은 지불자뿐이다');
      if (!state.offer.rails.includes(frame.rail)) return reject(state, `${frame.rail} 은 offer 에 없던 레일이다`);
      return { ok: true, state: { ...state, status: 'locked', rail: frame.rail, railRef: frame.ref, presig: frame.presig } };
    }

    case 'reveal': {
      if (state.status !== 'locked') return reject(state, `${state.status} 상태에서 reveal`);
      if (frame.contract !== state.contract) return reject(state, 'reveal 이 다른 계약을 가리킨다');
      if (frame.from !== state.payeeDid) return reject(state, '공개하는 쪽은 수취인뿐이다');
      if (nowMs >= state.offer.refundAfterMs) return reject(state, '환불 창이 이미 열렸다');
      if (!verifySecret(state.offer.lock, state.statement, frame.secret)) {
        return reject(state, '비밀이 진술을 열지 못한다');
      }
      return { ok: true, state: { ...state, status: 'claimed', secret: frame.secret } };
    }

    case 'refund': {
      if (state.status !== 'locked') return reject(state, `${state.status} 상태에서 refund`);
      if (frame.contract !== state.contract) return reject(state, 'refund 가 다른 계약을 가리킨다');
      if (frame.from !== state.payerDid) return reject(state, '환불받는 쪽은 지불자뿐이다');
      if (nowMs < state.offer.refundAfterMs) return reject(state, '환불 창이 아직 열리지 않았다');
      return { ok: true, state: { ...state, status: 'refunded' } };
    }

    case 'cancel': {
      if (state.status !== 'proposed' && state.status !== 'accepted') {
        return reject(state, `${state.status} 상태에서 cancel`);
      }
      if (state.status === 'accepted' && frame.contract !== state.contract) {
        return reject(state, 'cancel 이 다른 계약을 가리킨다');
      }
      if (!isParty(state, frame.from)) return reject(state, '당사자가 아닌 쪽의 cancel');
      return { ok: true, state: { ...state, status: 'cancelled' } };
    }

    case 'receipt': {
      // 종결 뒤의 확인일 뿐, 상태를 옮기지 않는다.
      if (!TERMINAL.has(state.status)) return reject(state, '종결 전의 receipt');
      if (frame.contract !== state.contract) return reject(state, 'receipt 가 다른 계약을 가리킨다');
      if (!isParty(state, frame.from)) return reject(state, '당사자가 아닌 쪽의 receipt');
      if (frame.outcome !== state.status) return reject(state, `receipt 의 ${frame.outcome} 가 ${state.status} 와 다르다`);
      return { ok: true, state };
    }
  }
};

// ── 방과 노트 이름 ───────────────────────────────────────────────────────────
const requireContract = (c) => { if (!HEX32.test(c)) fail(`계약 id 형식이 틀렸다: ${c}`); return c; };

// 거래방은 고르는 게 아니라 유도하는 것이다. 양쪽이 같은 계약 id 에서 같은 이름에 도착한다.
// 이름이 유도된다는 건 비밀이 아니라는 뜻이기도 하다 — 게시판을 읽은 사람은 누구나 같은
// 계산을 하고, 읽기에는 서명이 필요 없다. mb- 는 쓰는 쪽을 묶고 p- 는 목록에서 뺄 뿐이다.
export const dealRoom = (contract) => 'mb-p-tclk-' + requireContract(contract).slice(2, 18);

// 상태 노트는 권위가 아니라 폴링을 아껴주는 힌트다. 그 네임스페이스는 누구나 쓸 수 있으므로
// 중요한 판단은 서명된 프레임과 레일에서 다시 끌어온다.
export const stateNote = (contract) => {
  const id = requireContract(contract);
  return { ns: 'tclk-' + id.slice(2, 4), key: id.slice(4, 18) };
};

export const stateNoteValue = (status, railRef) => {
  if (!STATUSES.includes(status)) fail(`모르는 상태: ${status}`);
  if (railRef === undefined) return status;
  if (!/^[\x21-\x7e]{1,256}$/.test(railRef)) fail('rail ref 는 공백 없는 출력 가능 ASCII 여야 한다');
  return `${status} ${railRef}`;
};

export const parseStateNoteValue = (value) => {
  const [status, railRef, ...rest] = value.split(' ');
  if (rest.length > 0 || !STATUSES.includes(status)) return null;
  return railRef === undefined ? { status } : { status, railRef };
};

// DID 노트에 붙이는 능력 토큰. 있다는 건 tclk/1 을 말한다는 뜻이고, 값은 받아들이는 레일이다.
// 노트는 누구나 쓸 수 있으므로 이건 증거가 아니라 길잡이다.
export const capabilityToken = (rails) => {
  if (!rails.length) fail('능력 토큰에는 레일이 최소 하나 필요하다');
  for (const r of rails) if (!RAIL.test(r)) fail(`레일 이름이 틀렸다: ${r}`);
  return 'tclk1:' + rails.join(',');
};

export const parseCapabilityToken = (note) => {
  const token = note.split(/\s+/).find((p) => p.startsWith('tclk1:'));
  if (token === undefined) return null;
  const rails = token.slice(6).split(',').filter(Boolean);
  if (!rails.length) return null;
  return rails.every((r) => RAIL.test(r)) ? rails : null;
};

// ── 전송 ─────────────────────────────────────────────────────────────────────
// 규격은 프레임의 from 이 전송 계층이 검증한 from 과 같아야 한다고 요구한다. 서버가 붙여준
// from 을 믿는 대신 우리가 서명을 다시 검증한다 — verify.js 가 그 일을 한다. 서명이
// 재검증되지 않는 기록에서 나온 프레임은 데이터일 뿐 약속이 아니므로 이유를 달아 버린다.
export const readFrames = async (room, limit = 200, base = BASE) => {
  const records = await fetchRecords(room, limit, base);
  const out = [];
  for (const rec of records) {
    if (!isTclkLine(rec.text)) continue;
    const frame = tryDecodeFrame(rec.text);
    if (!frame) { out.push({ seq: rec.seq, from: rec.from, frame: null, why: '망가진 tclk 줄' }); continue; }
    const v = verifyRecord(room, rec);
    if (!v.ok) { out.push({ seq: rec.seq, from: rec.from, frame, why: '서명 재검증 실패: ' + v.why }); continue; }
    if (frame.from !== rec.from) { out.push({ seq: rec.seq, from: rec.from, frame, why: 'frame.from 이 서명한 DID 와 다르다' }); continue; }
    out.push({ seq: rec.seq, from: rec.from, frame, why: null });
  }
  return out;
};

// 프레임을 서명 레인으로 올린다. 부르는 쪽이 키를 넘긴다 — 이 파일은 키를 읽지 않는다.
export const postFrame = async (room, frame, key, did, base = BASE) => {
  const line = encodeFrame(frame);
  const nonce = Date.now();
  const sig = sign(null, Buffer.from(`${room}|${nonce}|${line}`), key).toString('base64url');
  const res = await fetch(`${base}/r/${room}/say-signed/${did}/${sig}/${nonce}/${encodeURIComponent(line)}`);
  return { ok: res.ok, status: res.status, line };
};

// 상태 노트를 CAS 로 옮긴다. 두 일꾼이 같은 계약을 동시에 진행시키지 못하게 하는 것뿐이고,
// 이걸 이겼다고 돈이 움직이지는 않는다.
export const advanceNote = async (contract, from, to, base = BASE) => {
  const { ns, key } = stateNote(contract);
  const url = `${base}/kv/${ns}/${key}/set/${encodeURIComponent(to)}` + (from ? `?if=${encodeURIComponent(from)}` : '');
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 200) };
};

// ── CLI ──────────────────────────────────────────────────────────────────────
// 읽기와 로컬 시연만 있다. offer 를 올리는 명령은 일부러 넣지 않았다: 뒤에 아무 레일도
// 없는 서명된 offer 는 규격이 직접 경고하는 그 소음이고, 우리는 아직 정산할 자산이 없다.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
const cmd = isMain ? process.argv[2] : undefined;

if (cmd === 'offers' || cmd === 'read') {
  const room = cmd === 'read' ? process.argv[3] : OFFER_ROOM;
  const rows = await readFrames(room);
  console.log(`/r/${room}: tclk 줄 ${rows.length}건`);
  for (const r of rows) {
    const f = r.frame;
    console.log(`  [${r.seq}] ${f ? f.type : '?'}${r.why ? ' — 버림: ' + r.why : ''}`);
    if (f && !r.why) {
      console.log('      ' + (f.type === 'offer'
        ? `${f.amount} ${f.asset} · ${f.lock} · ${f.rails.join(',')} · ${f.id}`
        : (f.contract || '')));
    }
  }
  if (!rows.length) console.log('  (아직 아무도 프레임을 올리지 않았다)');
}

if (cmd === 'room') {
  const c = process.argv[3];
  const { ns, key } = stateNote(c);
  console.log(`거래방  : ${dealRoom(c)}`);
  console.log(`상태노트: /kv/${ns}/${key}`);
}

if (cmd === 'demo') {
  // 네트워크 없이 전 생애주기를 돌린다. 한 계약이 제안에서 청구까지 가는 모습.
  const A = 'did:key:z6Mk' + 'f'.repeat(44);
  const B = 'did:key:z6Mk' + 'g'.repeat(44);
  const now = Date.now();
  const offer = makeOffer({ from: A, role: 'payer', amount: '1000000', asset: 'FLOP', lock: 'hash',
    rails: ['flop-htlc'], claimByMs: now + 3600000, refundAfterMs: now + 7200000, expiresMs: now + 600000,
    job: { proto: 'a2a', id: 'task-demo' } });
  const { preimage, statement } = generateHashLock();
  const accept = makeAccept(offer, { from: B, statement });
  let s = openContract(offer);
  const steps = [
    accept,
    { type: 'lock', from: A, contract: accept.contract, rail: 'flop-htlc', ref: 'escrow-1' },
    { type: 'reveal', from: A, contract: accept.contract, secret: preimage },                 // 지불자가 공개 → 거절
    { type: 'reveal', from: B, contract: accept.contract, secret: '0x' + '11'.repeat(32) },   // 틀린 비밀 → 거절
    { type: 'reveal', from: B, contract: accept.contract, secret: preimage },
    { type: 'receipt', from: B, contract: accept.contract, outcome: 'claimed' },
  ];
  console.log(`계약   : ${accept.contract}`);
  console.log(`거래방 : ${dealRoom(accept.contract)}`);
  console.log(`상태   : ${s.status}`);
  for (const f of steps) {
    const r = applyFrame(s, f, Date.now());
    s = r.state;
    console.log(`  ${f.type.padEnd(7)} ${r.ok ? '수락' : '거절'} → ${s.status}${r.ok ? '' : '  (' + r.reason + ')'}`);
  }
}

if (isMain && !['offers', 'read', 'room', 'demo'].includes(cmd)) {
  console.log('사용법: node tclk.js demo | offers | read <방> | room <계약id>');
}
