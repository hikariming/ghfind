import {describe,it,expect} from "vitest";
import {renderTrafficReport,trafficDelta,trafficNumber} from "../traffic-report";
import {trafficDue,trafficComplete,type TrafficSchedule} from "../traffic-schedule";
import {DAY,type TrafficReport} from "../traffic-metrics";
export const fixture:TrafficReport={generatedAt:Date.parse("2026-10-22T04:00:00Z"),end:Date.parse("2026-10-22T00:00:00Z"),visitorSource:"RUM 浏览器访问",metrics:[{key:"visitors",label:"访客",values:[{current:1234,previous:1000},{current:3000,previous:0},{current:7000,previous:null}]},{key:"bytes",label:"带宽",unit:"bytes",values:[{current:2e9,previous:1e9},{current:0,previous:0},{current:null,previous:1}]}],days:Array.from({length:7},(_,i)=>({date:`2026-10-${15+i}`,value:i*100})),paths:[{label:'/scan/example-user?x=<script>"',value:99}],countries:[{label:"CN",value:300}],referrers:[{label:"example.org",value:21}],notes:["假数据，无生产账号"]};
describe("traffic HTML",()=>{
 it("renders a separate accessible table email and complete plaintext",()=>{
  const r=renderTrafficReport(fixture);expect(r.subject).toBe("[ghfind][流量日报] 24h 访客 1,234（↑23.4%） · 10-22");
  expect(r).toMatchSnapshot();expect(r.html).not.toContain("<script>");expect(r.html).toContain("&lt;script&gt;");expect(r.html).not.toMatch(/<svg|<img|<script/);expect(r.text).toContain("2.00 GB");expect(r.text).toContain("Top referrer");expect(r.text).toContain("2026-10-22 08:00");
 });
 it("shows unavailable reasons inline without emitting a misleading percentage",()=>{
  const data=structuredClone(fixture);data.metrics[0].values[0]={current:1234,previous:null,previousReason:"前期数据不足 2 天"};data.metrics[1].values[0]={current:null,previous:null,currentReason:"需要 Zone Analytics 读权限"};
  data.unavailable={paths:"需要 Zone Analytics 读权限"};data.paths=[];
  const r=renderTrafficReport(data);expect(r.subject).toContain("—（前期数据不足 2 天）");expect(r.html).toContain("需要 Zone Analytics 读权限");expect(r.text).toContain("窗口：2026-10-21 08:00 → 2026-10-22 08:00 UTC+8");expect(r.headers).toEqual({"Auto-Submitted":"auto-generated","Content-Language":"zh-CN"});
 });
 it("renders email-safe stacked request bars alongside RUM and preserves unknown segments",()=>{
  const data=structuredClone(fixture);data.requests={source:"边缘全部请求（估算）",values:fixture.metrics[0].values,days:[{date:"2026-10-21",total:100,browser:30,api:20,other:50},{date:"2026-10-20",total:80,browser:null,api:null,other:null,reason:"本次限流未取到"}],workers:{values:fixture.metrics[0].values,scripts:[{label:"ghfind-api",value:200}]}};
  const r=renderTrafficReport(data);expect(r.html).toContain("7 天访客趋势");expect(r.html).toContain("全部请求量 · 7 天");expect(r.html).toContain('bgcolor="#0d9488"');expect(r.html).toContain('bgcolor="#2563eb"');expect(r.text).toContain("总量 100 / 浏览器 UA 页面 30 / API 20 / 其他 50");expect(r.text).toContain("浏览器 UA 页面 —");expect(r.html).not.toMatch(/<svg|<img|<canvas/);
 });
 it("handles zero denominators, missing values and the neutral band",()=>{
  expect(trafficDelta(0,0).text).toBe("±0%");expect(trafficDelta(1,0).text).toContain("新增");expect(trafficDelta(null,1).text).toBe("—");expect(trafficDelta(0,1).text).toBe("↓100.0%");expect(trafficDelta(105,100).color).toBe(trafficDelta(95,100).color);expect(trafficDelta(106,100).color).not.toBe(trafficDelta(94,100).color);
 });
 it("formats decimal units and unavailable counts",()=>{expect(trafficNumber(12345)).toBe("12,345");expect(trafficNumber(1200,"bytes")).toBe("1.20 KB");expect(trafficNumber(0.1234,"percent")).toBe("0.12%");expect(trafficNumber(null)).toBe("—");});
});
describe("traffic schedule",()=>{
 const noon=Date.parse("2026-10-22T04:00:00Z");
 it("waits until noon then sends only once",()=>{const s:TrafficSchedule={};expect(trafficDue(s,noon-1)).toBe(false);expect(trafficDue(s,noon)).toBe(true);trafficComplete(s,noon);expect(trafficDue(s,noon+1)).toBe(false);expect(trafficDue(s,noon+DAY)).toBe(true);});
 it("a first deployment after local midnight still waits for local noon",()=>{const s:TrafficSchedule={};expect(trafficDue(s,noon-11*3600_000)).toBe(false);expect(s.nextTrafficReport).toBe(noon);});
 it("keeps same-local-day receipts when overnight catchup crosses the noon slot",()=>{const s:TrafficSchedule={nextTrafficReport:noon-DAY};expect(trafficDue(s,noon-11*3600_000)).toBe(true);s.trafficRecipients=["owner@example.org"];trafficComplete(s,noon-11*3600_000);expect(trafficDue(s,noon)).toBe(true);expect(s.trafficRecipients).toEqual(["owner@example.org"]);trafficComplete(s,noon);expect(trafficDue(s,noon+1)).toBe(false);});
 it("catches up one report after multiple missed days",()=>{const s:TrafficSchedule={nextTrafficReport:noon};expect(trafficDue(s,noon+4*DAY+1)).toBe(true);trafficComplete(s,noon+4*DAY+1);expect(s.nextTrafficReport).toBe(noon+5*DAY);expect(trafficDue(s,noon+4*DAY+2)).toBe(false);});
 it("preserves accepted recipients on retry and resets on next slot",()=>{const s:TrafficSchedule={};trafficDue(s,noon);s.trafficRecipients=["owner@example.org"];trafficDue(s,noon+1);expect(s.trafficRecipients).toHaveLength(1);trafficDue(s,noon+DAY);expect(s.trafficRecipients).toEqual([]);});
});
