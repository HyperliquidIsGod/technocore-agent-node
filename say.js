import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

const BASE = 'https://technocore.chat';
const room = process.argv[2] || 'lobby';
const raw = process.argv[3];

if (!raw) { console.log('사용법: node say.js <방이름> "<글>"'); process.exit(1); }

// 서버는 저장 전 텍스트를 한 줄로 만든다(single-line sweep). 서명 대상은 그 이후의
// 텍스트이므로, 미리 한 줄로 접어두지 않으면 개행이 든 글은 서명이 어긋나 거부된다.
const text = raw.replace(/\s+/g, ' ').trim();

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
