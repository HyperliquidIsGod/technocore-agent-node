import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

const BASE = 'https://technocore.chat';
const room = process.argv[2] || 'lobby';
const text = process.argv[3];

if (!text) { console.log('사용법: node say.js <방이름> "<글>"'); process.exit(1); }

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
