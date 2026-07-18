#!/usr/bin/env bash
# 干净流量报表 — 把 Vercel Observability 请求数据按层拆开,供运营复盘用。
#
# 背景:站点大量流量来自伪装成真人浏览器的无头爬虫(轮换代理机房 IP,会执行 JS),
# Vercel Analytics / GA4 面板数字被污染。做增长判断时以这份分层报表为准:
#   真人层  = 动作端点(scan/roast/search)+ 非机房网络的页面流量
#   agent 层 = 自报身份的爬虫/AI 助手(变现漏斗的目标,是好流量)
#   农场层  = 代理机房 ASN 的匿名流量(白噪音,忽略即可)
#
# 用法: scripts/traffic-report.sh [时间窗口]   # 默认 24h,支持 1h/4h/3d/7d
set -euo pipefail

SINCE="${1:-24h}"

# 高置信代理/爬虫农场 ASN(2026-07 实测:Oxylabs、Datacamp、M247 等,真人几乎不会从这些网络来)
# 2026-07-06 增补:农场开始伪造 referrer=www.google.com,借伪造流量暴露了一批新 ASN —
#   401152/11798 Ace Data Centers、212286 LonConnect、134450 HostRoyale二号段、
#   132817 DZCRD、209709 code200、201341 trafficforce、393886 Leaseweb、210906 Bite(代理转售段)
# 2026-07-17 增补:新农场波(HTML 加载 2.4×日均而 scan/roast 动作反跌)暴露的机房段 —
#   30058 FDCservers、398781 Oculus、153371 Back Waves、51847 Nearoute、25820 IT7、
#   199524 G-Core、45102 Alibaba US(有机场中继风险,challenge 可过,盯动作数)、396982 GCP
PROXY_ASNS='["212238","9009","3257","203020","210906","62874","7979","396356","46635","11798","396319","59253","55286","401152","212286","134450","132817","209709","201341","393886","30058","398781","153371","51847","25820","199524","45102","396982"]'
# 注意:机场/VPN 出口(Eons 138997、DMIT、Akari、Bunny、GSL 等)有真实中国用户,刻意不算进农场层。
AWS_ASNS='["14618","16509"]'

q() { vercel metrics "$@" --since "$SINCE" --format=json 2>/dev/null; }

total=$(q vercel.request.count | jq '.summary[0].vercel_request_count_sum // 0')

# asn × bot_category 交叉表,各层互不重叠(2026-07-15 修复:此前 AWS 层与声明式爬虫
# 重复扣减 — claude-searchbot 正是从 AWS 出口来的,大爬取日会把真人层算成负数)
cross=$(q vercel.request.count --group-by asn_id --group-by bot_category --limit 500)
declared=$(echo "$cross" | jq \
  '[.summary[]? | select((.bot_category // "") != "" and .bot_category != "browser_impersonation") | .vercel_request_count_sum] | add // 0')
impersonation=$(echo "$cross" | jq \
  '[.summary[]? | select(.bot_category == "browser_impersonation") | .vercel_request_count_sum] | add // 0')
proxy=$(echo "$cross" | jq --argjson ids "$PROXY_ASNS" \
  '[.summary[]? | select((.bot_category // "") == "" and (.asn_id as $a | $ids | index($a))) | .vercel_request_count_sum] | add // 0')
aws=$(echo "$cross" | jq --argjson ids "$AWS_ASNS" \
  '[.summary[]? | select((.bot_category // "") == "" and (.asn_id as $a | $ids | index($a))) | .vercel_request_count_sum] | add // 0')

action_count() { q vercel.request.count -f "request_path eq '$1'" | jq '.summary[0].vercel_request_count_sum // 0'; }
scan=$(action_count /api/scan)
roast=$(action_count /api/roast)
search=$(action_count /api/search-users)

rest=$((total - proxy - aws - declared - impersonation))

pct() { [ "$total" -gt 0 ] && echo "$1" | awk -v t="$total" '{printf "%.1f%%", $1 * 100 / t}' || echo "0%"; }

echo "══════════ 流量分层报表(近 $SINCE)══════════"
echo "总请求:            $total"
echo
echo "── 农场层(白噪音,运营时忽略)"
echo "代理机房 ASN:      $proxy ($(pct "$proxy"))   ← Oxylabs/Datacamp/M247 等爬虫农场"
echo "AWS:               $aws ($(pct "$aws"))"
echo "伪装浏览器(已识别): $impersonation ($(pct "$impersonation"))"
echo
echo "── agent 层(自报身份,变现漏斗的客户)"
echo "声明式爬虫/AI:     $declared ($(pct "$declared"))"
echo
echo "── 真人层(核心运营指标)"
echo "疑似真人流量:      $rest ($(pct "$rest"))   ← 剩余量,仍含未识别爬虫,看趋势别看绝对值"
echo "扫描动作 /api/scan:   $scan"
echo "吐槽动作 /api/roast:  $roast"
echo "搜索动作 /api/search: $search"
echo
echo "声明式爬虫明细(谁在光顾 agent 漏斗):"
q vercel.request.count --group-by bot_name --limit 12 \
  | jq -r '.summary[]? | select((.bot_name // "") != "") | "  \(.vercel_request_count_sum)\t\(.bot_name)"'

# ── 搜索来源可信度 ─────────────────────────────────────────────
# 农场自 2026-07-04 起伪造 referrer=www.google.com 假装 SEO 流量,
# referrer 维度单看会得出"SEO 爆发"的错误结论。此处按 ASN 交叉验证:
# 农场 ASN ∩ google referrer = 伪造;居民 ISP 出口的剩余量 ≈ 真实 SEO。
g_by_asn=$(q vercel.request.count -f "referrer_hostname eq 'www.google.com'" --group-by asn_id --limit 200)
g_total=$(echo "$g_by_asn" | jq '[.summary[]?.vercel_request_count_sum] | add // 0')
g_farm=$(echo "$g_by_asn" | jq --argjson ids "$PROXY_ASNS" \
  '[.summary[]? | select(.asn_id as $a | $ids | index($a)) | .vercel_request_count_sum] | add // 0')
g_real=$((g_total - g_farm))
echo
echo "── 搜索来源可信度(google referrer 按 ASN 交叉验证)"
echo "自称来自 Google:    $g_total"
echo "其中农场伪造:      $g_farm"
echo "疑似真实 SEO:      $g_real   ← 仍含未识别农场 ASN,看趋势;做 SEO 判断以这行为准"
