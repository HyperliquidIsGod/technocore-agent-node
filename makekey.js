import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import bs58 from 'bs58';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const did = 'did:key:z' + bs58.encode(
  Buffer.concat([Buffer.from([0xed, 0x01]), rawPub])
);

writeFileSync('secret.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
console.log('내 DID:', did);
