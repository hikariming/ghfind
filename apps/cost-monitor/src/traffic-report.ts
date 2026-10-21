import type { TrafficReport, TrafficMetric, Comparison, RequestTraffic } from "./traffic-metrics";
const escape=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function trafficDelta(current:number|null,previous:number|null,missingReason?:string):{text:string;color:string} {
  if(current===null||previous===null)return {text:missingReason?`—（${missingReason}）`:"—",color:"#64748b"};
  if(previous===0)return current===0?{text:"±0%",color:"#64748b"}:{text:"新增（前期为 0）",color:"#15803d"};
  const n=(current-previous)/previous*100;
  return {text:`${n>0?"↑":n<0?"↓":"±"}${Math.abs(n).toFixed(1)}%`,color:Math.abs(n)<=5?"#64748b":n>0?"#15803d":"#b91c1c"};
}
export function trafficNumber(n:number|null,unit?:TrafficMetric["unit"]):string {
  if(n===null)return "—";
  if(unit==="percent")return `${n.toFixed(2)}%`;
  if(unit==="bytes")return n>=1e9?`${(n/1e9).toFixed(2)} GB`:n>=1e6?`${(n/1e6).toFixed(2)} MB`:n>=1e3?`${(n/1e3).toFixed(2)} KB`:`${n} B`;
  return n.toLocaleString("en-US",{maximumFractionDigits:0});
}
const comparisonDelta=(v:Comparison)=>trafficDelta(v.current,v.previous,v.current===null?undefined:v.previousReason);
const valueText=(v:Comparison,unit?:TrafficMetric["unit"])=>v.current===null&&v.currentReason?`—（${v.currentReason}）`:trafficNumber(v.current,unit);
const local=(at:number)=>new Date(at+8*3600_000).toISOString().slice(0,16).replace("T"," ");
function requestSection(data:RequestTraffic):{html:string;text:string} {
  const max=Math.max(1,...data.days.map(d=>d.total??0));
  const split=data.days.some(d=>d.browser!==null&&d.api!==null&&d.other!==null);
  const bars=data.days.map(d=>{
    const totalHeight=d.total===null?0:Math.round(d.total/max*90);
    const hasSplit=d.browser!==null&&d.api!==null&&d.other!==null;
    const browser=hasSplit?Math.round((d.browser??0)/max*90):0;
    const api=hasSplit?Math.min(totalHeight-browser,Math.round((d.api??0)/max*90)):0;
    const other=totalHeight-browser-api;
    const segment=(h:number,color:string)=>h>0?`<tr><td height="${h}" bgcolor="${color}" style="height:${h}px;background:${color};font-size:0;line-height:0">&nbsp;</td></tr>`:"";
    return `<td style="width:14.28%;padding:0 2px;text-align:center;vertical-align:bottom"><span class="muted" style="font-size:9px;color:#475569">${trafficNumber(d.total)}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td height="${90-totalHeight}" style="font-size:0;line-height:0"></td></tr>${segment(other,"#64748b")}${segment(api,"#0d9488")}${segment(browser,"#2563eb")}</table><span class="muted" style="font-size:10px;color:#64748b">${escape(d.date.slice(5))}</span></td>`;
  }).join("");
  const totals=data.values.map((v,i)=>`<td style="width:33.33%;padding:10px 4px;vertical-align:top;overflow-wrap:anywhere"><span class="muted" style="font-size:12px;color:#64748b">${["24h","3d","7d"][i]}</span><br><strong style="font-size:15px">${escape(valueText(v))}</strong><br><span class="muted" style="font-size:11px;color:#64748b">${escape(comparisonDelta(v).text)}</span></td>`).join("");
  const why=data.breakdownReason??data.days.find(d=>d.reason)?.reason;
  const legend=split?"蓝：浏览器 UA 页面 · 绿：API/MCP/webhook · 灰：其他（含脚本、静态）；分类缺失的日期为总量灰柱":"灰：总量（口径见上）；没有可靠的浏览器/API 分类，未填零。";
  const workers=data.workers.values.map((v,i)=>`${["24h","3d","7d"][i]} ${valueText(v)}`).join(" / ");
  const scripts=data.workers.scripts.map(s=>`${s.label}: ${trafficNumber(s.value)}`).join("；");
  return {
    html:`<h2 style="font-size:18px;margin:30px 0 8px">全部请求量 · 7 天</h2><p class="muted" style="font-size:12px;color:#64748b;line-height:1.7">${escape(data.source)}${why?`<br>分类/边缘数据：${escape(why)}`:""}</p><table role="presentation" width="100%" style="table-layout:fixed"><tr>${totals}</tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;margin-top:14px"><tr>${bars}</tr></table><p class="muted" style="font-size:11px;color:#64748b;line-height:1.7">${escape(legend)}<br>每柱为 UTC 日，覆盖北京时间 08:00 至次日 08:00；UA 分类不能识别全部机器人。</p><p class="muted" style="font-size:11px;color:#64748b;overflow-wrap:anywhere;line-height:1.7">Workers 补充（非边缘去重，不与请求量相加）：${escape(workers)}${scripts?`<br>24h 服务调用：${escape(scripts)}`:""}</p>`,
    text:["全部请求量 · 7 天",data.source,...data.values.map((v,i)=>`${["24h","3d","7d"][i]}: ${valueText(v)} (${comparisonDelta(v).text})`),why?`分类/边缘数据：${why}`:"",legend,...data.days.map(d=>`${d.date}: 总量 ${trafficNumber(d.total)} / 浏览器 UA 页面 ${trafficNumber(d.browser)} / API ${trafficNumber(d.api)} / 其他 ${trafficNumber(d.other)}${d.reason?` (${d.reason})`:""}`),`Workers 补充（不相加）：${workers}`,scripts].filter(Boolean).join("\n"),
  };
}
export function renderTrafficReport(data:TrafficReport): {subject:string;html:string;text:string;headers:Record<string,string>} {
  const visitor=data.metrics.find(m=>m.key==="visitors")?.values[0]??{current:null,previous:null};
  const delta=comparisonDelta(visitor);
  const summary=`24h 访客 ${valueText(visitor)}（${delta.text}）`;
  const subject=`[ghfind][流量日报] ${summary} · ${local(data.generatedAt).slice(5,10)}`;
  const requests=data.requests?requestSection(data.requests):{html:"",text:""};
  const border="border-bottom:1px solid #e2e8f0;";
  const cell=`overflow-wrap:anywhere;word-break:normal;padding:12px 6px;${border}text-align:right;vertical-align:top;`;
  const rows=data.metrics.map(m=>`<tr><th scope="row" style="${cell}text-align:left;font-size:13px;font-weight:500">${escape(m.label)}</th>${m.values.map(v=>{const d=comparisonDelta(v);return `<td style="${cell}"><strong style="font-size:15px">${escape(valueText(v,m.unit))}</strong><br><span class="delta-${d.color==="#15803d"?"up":d.color==="#b91c1c"?"down":"neutral"}" style="font-size:11px;color:${d.color}">${escape(d.text)}</span></td>`;}).join("")}</tr>`).join("");
  const max=Math.max(1,...data.days.map(d=>d.value??0));
  const bars=data.days.map(d=>{const h=d.value===null?0:Math.max(d.value?3:0,Math.round(d.value/max*76));return `<td style="width:14.28%;padding:0 3px;text-align:center;vertical-align:bottom"><span class="muted" style="font-size:10px;color:#475569">${escape(trafficNumber(d.value))}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td height="${76-h}"></td></tr><tr><td height="${h}" bgcolor="#4f46e5" style="background:#4f46e5;border-radius:3px 3px 0 0"></td></tr></table><span class="muted" style="font-size:11px;color:#64748b">${escape(d.date.slice(5))}</span></td>`;}).join("");
  const lists=([['Top 路径',data.paths,data.unavailable?.paths],['Top 国家 / 地区',data.countries,data.unavailable?.countries],['Top referrer',data.referrers,data.unavailable?.referrers]] as const).map(([name,items,why])=>`<h2 style="font-size:17px;margin:28px 0 10px">${name}<span style="font-size:11px;font-weight:400;color:#64748b"> · 24h ${name==="Top referrer"?"页面加载":"请求"}</span></h2><table width="100%" style="border-collapse:collapse;table-layout:fixed">${items.length?items.slice(0,10).map(r=>`<tr><td style="${border}padding:8px 0;overflow-wrap:anywhere;word-break:break-all;font-size:13px">${escape(r.label)}</td><td width="85" style="${border}padding:8px 0;text-align:right;font-size:13px">${trafficNumber(r.value)}</td></tr>`).join(""):`<tr><td class="muted" style="color:#64748b;font-size:13px">${escape(why??"暂无可用数据")}</td></tr>`}</table>`).join("");
  const ranges=[1,3,7].map(d=>`${d===1?"24h":`${d}d`}：${local(data.end-d*86400_000)} → ${local(data.end)}；前期 ${local(data.end-2*d*86400_000)} → ${local(data.end-d*86400_000)}`);
  const window=`窗口：${local(data.end-86400_000)} → ${local(data.end)} UTC+8`;
  const notes=[`访客口径：${data.visitorSource}`,"全部时间为 UTC+8；右边界不包含在内。",...ranges,...data.notes,`生成时间：${local(data.generatedAt)} UTC+8`];
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>@media(prefers-color-scheme:dark){body,.canvas{background:#111827!important}.sheet{background:#1e293b!important;color:#f1f5f9!important}td,th{border-color:#475569!important}.muted{color:#cbd5e1!important}.delta-up{color:#86efac!important}.delta-down{color:#fca5a5!important}.delta-neutral{color:#cbd5e1!important}}</style></head><body style="margin:0;background:#f1f5f9;font-family:Arial,'Microsoft YaHei',sans-serif;color:#0f172a"><table role="presentation" class="canvas" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 8px"><table role="presentation" class="sheet" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;color:#0f172a;border-radius:12px"><tr><td style="padding:28px 16px"><p class="muted" style="margin:0;color:#64748b;font-size:12px;letter-spacing:1px">GHFIND / 流量日报 · ${local(data.generatedAt).slice(0,10)}</p><h1 style="font-size:24px;line-height:1.4;margin:16px 0 8px">${escape(summary)}</h1><p class="muted" style="font-size:13px;color:#475569;margin:0 0 24px">${escape(data.visitorSource)}<br>${escape(window)}<br>按完整 UTC 日统计；正式日报每天 12:00 UTC+8 发送。</p><table width="100%" style="border-collapse:collapse;table-layout:fixed"><thead><tr><th style="${cell}text-align:left;width:31%">指标</th>${["24h","3d","7d"].map(s=>`<th scope="col" style="${cell}font-size:13px">${s}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table><h2 style="font-size:17px;margin:28px 0 14px">7 天访客趋势</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${bars}</tr></table><p class="muted" style="font-size:11px;color:#64748b">按 UTC 日分桶；每个柱覆盖北京时间 08:00 至次日 08:00。</p>${requests.html}${lists}<h2 style="font-size:16px;margin:28px 0 12px">数据说明</h2>${notes.map(n=>`<p class="muted" style="font-size:11px;line-height:1.7;color:#64748b;margin:7px 0;overflow-wrap:anywhere">${escape(n)}</p>`).join("")}</td></tr></table></td></tr></table></body></html>`;
  const text=[subject,window,`访客口径：${data.visitorSource}`,"指标 | 24h | 3d | 7d",...data.metrics.map(m=>`${m.label} | ${m.values.map(v=>`${valueText(v,m.unit)} (${comparisonDelta(v).text})`).join(" | ")}`),"7 天访客趋势",...data.days.map(d=>`${d.date}: ${trafficNumber(d.value)}`),requests.text,...([['Top 路径',data.paths,data.unavailable?.paths],['Top 国家 / 地区',data.countries,data.unavailable?.countries],['Top referrer',data.referrers,data.unavailable?.referrers]] as const).flatMap(([n,rs,why])=>[n,...(rs.length?rs.map(r=>`${r.label}: ${trafficNumber(r.value)}`):[why??"暂无可用数据"])]),...notes].join("\n");
  return {subject,html,text,headers:{"Auto-Submitted":"auto-generated","Content-Language":"zh-CN"}};
}
