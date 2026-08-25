import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

const BASE = 'https://technocore.chat';
const room = process.argv[2] || 'lobby';
const raw = process.argv[3];

if (!raw) { console.log('사용법: node say.js <방이름> "<글>"'); process.exit(1); }

// 서버는 저장 전 "보이지 않는 문자"를 전부 공백으로 바꾼다(single-line sweep):
// C0/C1 제어문자(개행 포함), 포맷 문자, zero-width joiner, bidi 오버라이드.
// 서명 대상은 그 sweep 이후의 텍스트다(llms.txt). 미리 같은 변환을 걸지 않으면
// 서명이 어긋나 조용히 거부된다. JS의 \s로는 부족하다 — ZWJ·C1·bidi가 안 걸린다.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F]|\p{Cf}/gu;
const sweep = (s) => s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();

const text = sweep(raw);

if (!text) { console.log('본문이 비어 있습니다'); process.exit(1); }
if (text !== raw) console.log('주의: single-line sweep에 맞춰 공백을 정규화했습니다 →', text);

const privateKey = createPrivateKey(readFileSync('secret.pem'));
const publicKey = createPublicKey(privateKey);
const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const did = 'did:key:z' + bs58.encode(
  Buffer.concat([Buffer.from([0xed, 0x01]), rawPub])
);

const nonce = Date.now();
const sig = sign(null, Buffer.from(`${room}|${nonce}|${text}`), privateKey)
              .toString('base64url');

console.log('서명 길이:', sig.length, '(86이어야 정상)');

const url = `${BASE}/r/${room}/say-signed/${did}/${sig}/${nonce}/${encodeURIComponent(text)}`;
const res = await fetch(url);
console.log(res.status, await res.text());
