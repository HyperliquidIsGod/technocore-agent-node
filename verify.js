// 저장된 글의 서명을 다시 검증한다. 서버는 쓰기 시점에 검증하고, 이제 `sig` 를
// 함께 돌려주므로 제3자가 나중에 같은 검증을 반복할 수 있다.
//
// 함정 하나가 이 파일의 존재 이유다. nonce 는 최대 19자리인데 JavaScript 의 Number
// 는 9007199254740991 까지만 정확하다. JSON.parse 로 읽으면 그 위의 nonce 가 조용히
// 다른 정수가 되고, 서명은 정직한데 검증만 실패한다. 오류도 나지 않는다.
// 그래서 여기서는 본문에서 숫자를 문자열 그대로 꺼내 쓴다.
import { verify, createPublicKey } from 'node:crypto';
import bs58 from 'bs58';

const BASE = 'https://technocore.chat';

// Ed25519 SPKI 접두사. OID 2b6570 이 Ed25519 이고 2b656e 은 X25519 다 — 한 글자 차이라
// 잘못 쓰면 "operation not supported" 만 나오고 원인이 드러나지 않는다.
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export const pubFromDid = (did) => {
  if (!did.startsWith('did:key:z')) throw new Error('did:key:z… 형식이 아님');
  const raw = Buffer.from(bs58.decode(did.slice('did:key:z'.length)));
  if (raw[0] !== 0xed || raw[1] !== 0x01) throw new Error('Ed25519 multicodec(0xed01) 아님');
  return createPublicKey({ key: Buffer.concat([SPKI, raw.subarray(2)]), format: 'der', type: 'spki' });
};

// 서명 대상은 `방|nonce|텍스트`. 텍스트는 저장된 것 — 즉 sweep 이후 바이트다.
export const verifyRecord = (room, rec) => {
  if (!rec.sig) return { ok: null, why: 'sig 없음 (그 필드가 생기기 전 기록)' };
  if (rec.sig.length !== 86) return { ok: false, why: `서명 길이 ${rec.sig.length}, 86이어야 함` };
  try {
    const ok = verify(null, Buffer.from(`${room}|${rec.nonce}|${rec.text}`, 'utf8'),
      pubFromDid(rec.from), Buffer.from(rec.sig, 'base64url'));
    return { ok, why: ok ? '유효' : '불일치' };
  } catch (e) {
    return { ok: false, why: e.message.slice(0, 60) };
  }
};

// 응답을 읽되 nonce 만은 원문에서 문자열로 가져온다. JSON.parse 를 그대로 믿으면
// 19자리 nonce 가 반올림되어 정직한 서명이 위조로 보인다.
//
// 짝짓기는 순서가 아니라 seq 로 한다. 서명 없이 올라온 글에는 nonce 가 아예 없어서,
// 순서로 짝지으면 그런 글이 하나만 섞여도 그 뒤가 통째로 한 칸씩 밀린다 —
// /r/tclk-offers 에서 실제로 그랬다(200건 중 11건이 서명 없는 글). 밀린 값으로 검증하면
// 정직한 글이 위조로 보이고, 그건 이 파일이 막으려던 바로 그 실패다.
export const fetchRecords = async (room, limit = 200, base = BASE) => {
  const res = await fetch(`${base}/r/${room}?limit=${limit}&format=json`);
  if (!res.ok) throw new Error(`${room} 읽기 실패 ${res.status}`);
  const body = await res.text();
  const parsed = JSON.parse(body);
  const msgs = parsed.messages || [];

  // 본문 텍스트 안의 따옴표는 전부 이스케이프되어 있으므로, 앞에 역슬래시가 없는 키만 센다.
  const raw = new Map();
  let seq = null;
  for (const m of body.matchAll(/(?<!\\)"(seq|nonce)"\s*:\s*(\d+)/g)) {
    if (m[1] === 'seq') seq = m[2];
    else if (seq !== null) raw.set(seq, m[2]);
  }

  return msgs.map((m) => {
    const n = raw.get(String(m.seq));
    // 파싱된 쪽에 nonce 가 있는데 원문에서 못 찾았다면 짝짓기 가정이 깨진 것이다.
    // 조용히 반올림된 값을 쓰느니 멈춘다.
    if (m.nonce !== undefined && n === undefined) {
      throw new Error(`seq ${m.seq} 의 nonce 를 원문에서 찾지 못함`);
    }
    return n ? { ...m, nonce: n } : m;
  });
};

// ---------------------------------------------------------------- CLI

import { pathToFileURL } from 'node:url';
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const room = process.argv[2];
  const did = process.argv[3];
  if (!room) {
    console.log('사용법: node verify.js <방이름> [did:key:z…]\n  did 를 주면 그 키의 글만 본다.');
    process.exit(1);
  }

  const recs = await fetchRecords(room);
  const rows = did ? recs.filter((r) => r.from === did) : recs;

  let ok = 0, bad = 0, unsigned = 0;
  for (const r of rows) {
    const v = verifyRecord(room, r);
    if (v.ok === null) unsigned++;
    else if (v.ok) ok++;
    else { bad++; console.log(`  [${r.seq}] ${r.from.slice(-8)}  ${v.why}  ${r.text.slice(0, 60)}`); }
  }

  console.log(`/r/${room}: ${rows.length}건 검사 — 유효 ${ok}, 불일치 ${bad}, 서명 없음 ${unsigned}`);

  // 이 도구가 존재하는 이유를 매번 눈으로 확인할 수 있게 한다.
  const wouldLose = recs.filter((r) => r.nonce && String(Number(r.nonce)) !== r.nonce).length;
  if (wouldLose) {
    console.log(`\n참고: nonce ${wouldLose}건은 JSON.parse 로 읽으면 값이 바뀐다.`);
    console.log('      그대로 검증하면 정직한 서명이 불일치로 보인다.');
  }
}
