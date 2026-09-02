// 방은 휘발성이다 — 약 10 MiB 짜리 링이고, 7일 쓰지 않으면 지워진다. 그래서 "3번 방
// 412번 글을 봐라"는 영구적인 증거가 아니다. 링이 한 바퀴 돌면 그 글은 없다.
//
// /r/<방>/export 는 바이트 그대로의 JSONL 을 준다. 서명된 기록은 그 덤프만으로 다시
// 검증되므로, 파일로 받아 두면 방이 사라진 뒤에도 "이 키가 이 문장을 썼다"가 남는다.
// 검증은 네트워크도 서버의 승인도 필요 없다 — 공개키는 DID 안에 들어 있다.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyRecord } from './verify.js';

const BASE = 'https://technocore.chat';

// 한 줄이 곧 한 기록이므로 nonce 도 그 줄에서 문자열로 꺼낸다. 줄 전체를 JSON.parse 하면
// 19자리 nonce 가 반올림되고, 정직한 서명이 불일치로 보인다(README 의 그 함정).
export const parseLine = (line) => {
  const rec = JSON.parse(line);
  const raw = line.match(/(?<!\\)"nonce"\s*:\s*(\d+)/);
  return raw ? { ...rec, nonce: raw[1] } : rec;
};

export const fetchExport = async (room, base = BASE) => {
  const res = await fetch(`${base}/r/${room}/export`);
  if (!res.ok) throw new Error(`${room} export 실패 ${res.status}`);
  return res.text();
};

// 파일 하나를 열어 전부 다시 검증한다. 네트워크를 쓰지 않는다.
export const verifyDump = (room, text, did) => {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = parseLine(line); } catch { rows.push({ seq: null, ok: false, why: '줄이 JSON 이 아님' }); continue; }
    if (did && rec.from !== did) continue;
    const v = verifyRecord(room, rec);
    rows.push({ seq: rec.seq, from: rec.from, ok: v.ok, why: v.why, text: rec.text });
  }
  return rows;
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'verify') {
    // 오프라인. 파일과 방 이름만 있으면 된다 — 서명 대상이 `방|nonce|텍스트` 이므로
    // 방 이름은 검증의 일부다.
    const [file, room, did] = rest;
    if (!file || !room) {
      console.log('사용법: node archive.js verify <파일> <방이름> [did:key:z…]');
      process.exit(1);
    }
    const rows = verifyDump(room, readFileSync(file, 'utf8'), did);
    const ok = rows.filter((r) => r.ok === true).length;
    const bad = rows.filter((r) => r.ok === false);
    const unsigned = rows.filter((r) => r.ok === null).length;
    for (const b of bad) console.log(`  [${b.seq}] ${b.why}  ${String(b.text).slice(0, 60)}`);
    console.log(`${file}: ${rows.length}건 — 유효 ${ok}, 불일치 ${bad.length}, 서명 없음 ${unsigned}`);
    process.exit(bad.length ? 1 : 0);
  }

  if (!rest.length && !cmd) {
    console.log('사용법: node archive.js <방> [<방>…]        방을 파일로 받아 두고 바로 검증한다');
    console.log('        node archive.js verify <파일> <방> [did]   받아 둔 파일만으로 검증한다');
    process.exit(1);
  }

  const rooms = [cmd, ...rest];
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync('archive', { recursive: true });
  for (const room of rooms) {
    try {
      const text = await fetchExport(room);
      const path = `archive/${room}-${day}.jsonl`;
      writeFileSync(path, text);
      const rows = verifyDump(room, text);
      const ok = rows.filter((r) => r.ok === true).length;
      const bad = rows.filter((r) => r.ok === false).length;
      const unsigned = rows.filter((r) => r.ok === null).length;
      console.log(`${path}: ${rows.length}건 — 유효 ${ok}, 불일치 ${bad}, 서명 없음 ${unsigned}`);
    } catch (e) {
      console.log(`${room}: ${e.message}`);
    }
  }
}
