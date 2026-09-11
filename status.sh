#!/bin/bash
# 한 화면 상태 요약. 자고 일어나서 `bash ~/flop-agent/status.sh` 한 줄이면 된다.
cd /Users/apple/flop-agent
echo "══ $(date '+%Y-%m-%d %H:%M %Z')  (UTC $(date -u '+%H:%M'))"
echo
echo "── 상주 작업"
for L in com.jh.flop-agent com.jh.sonnet-open com.jh.sonnet-play com.jh.flop-maintain; do
  row=$(launchctl list | grep "$L$")
  pid=$(echo "$row" | awk '{print $1}')
  [ "$pid" = "-" ] && s="대기(스케줄)" || { ps -p "$pid" >/dev/null 2>&1 && s="실행중 PID $pid" || s="★죽음"; }
  printf "   %-22s %s\n" "${L#com.jh.}" "$s"
done
echo
echo "── 개시 절차 (등록→방요청→로스터)"
[ -f sonnet-open-state.json ] && python3 -c "import json;d=json.load(open('sonnet-open-state.json'));print('   단계:',d.get('step'),'| 방:',d.get('poem_room','-'),'| gen:',d.get('generation','-'))" || echo "   아직 시작 안 함"
tail -2 sonnet-open.log 2>/dev/null | sed 's/^/   /'
echo
echo "── 대회 턴"
tail -3 sonnet-play.log 2>/dev/null | sed 's/^/   /' || echo "   기록 없음"
echo
echo "── open-line 에이전트 (오늘)"
awk -v d="[$(date -u +%Y-%m-%d)" '$0>=d' auto.log 2>/dev/null | grep -oE "게시\(|SKIP|독백 방지|오류\(계속\)" | sort | uniq -c | sed 's/^/   /'
echo "   마지막: $(tail -1 auto.log | cut -c1-110)"
echo
echo "── 방 만료 / 문서 감시"
tail -4 maintain.log 2>/dev/null | grep -E "keepalive|docwatch|★" | sed 's/^/   /'
echo
echo "── 오늘 추론 비용 (Opus 5 \$5/\$25 per MTok)"
python3 - <<'PY'
import json,datetime
d=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
rows=[json.loads(l) for l in open('inference.log',encoding='utf-8') if l.strip() and l.find(d)>0]
if not rows: print("   오늘 호출 없음"); raise SystemExit
i=sum(r['in'] for r in rows); o=sum(r['out'] for r in rows)
print(f"   호출 {len(rows)}건  입력 {i:,}  출력 {o:,}  →  ${i*5/1e6+o*25/1e6:.3f}")
PY
