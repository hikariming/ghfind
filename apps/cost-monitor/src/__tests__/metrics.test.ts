import { describe,expect,it,vi } from "vitest";
import { billable,collect } from "../metrics";
import {validateFrame} from "../engine";
const now=1_800_000_000_000;
const config={account:"account",token:"private-token"};
function api(rows:unknown[]){return Response.json({data:{viewer:{accounts:[{rows}]}}});}
function fixture(query:string){
  if(query.includes("d1Queries"))return [{count:100,dimensions:{databaseId:"core",query:"SELECT * FROM sensitive WHERE username='private-user'"},sum:{rowsRead:38_000_000,rowsWritten:0,rowsReturned:1}}];
  if(query.includes("d1Analytics"))return [{dimensions:{databaseId:"core"},sum:{rowsRead:38_000_000,rowsWritten:20,readQueries:100,writeQueries:2}}];
  if(query.includes("workersInvocations"))return [{dimensions:{scriptName:"app"},sum:{requests:200,cpuTimeUs:100_000}}];
  if(query.includes("r2Operations"))return [{dimensions:{bucketName:"bucket",actionType:"ListParts",storageClass:"Standard"},sum:{requests:100,responseObjectSize:0}}];
  if(query.includes("r2Storage"))return [{dimensions:{bucketName:"bucket",storageClass:"Standard"},max:{payloadSize:1e9,metadataSize:0}}];
  if(query.includes("kvOperations"))return [{dimensions:{namespaceId:"cache",actionType:"write"},sum:{requests:100}}];
  return [];
}
const mockFetch=()=>vi.fn(async(_url:unknown,init?:RequestInit)=>api(fixture(JSON.parse(String(init?.body)).query)));
describe("aggregate collection",()=>{
  it("aggregates repeated Worker names, preserving CPU, cost and request-normalized operation totals",async()=>{
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const q=JSON.parse(String(init?.body)).query;
      if(q.includes("workersInvocations"))return api([...fixture(q),{dimensions:{scriptName:"app"},sum:{requests:300,cpuTimeUs:600_000}},...Array.from({length:2},()=>({dimensions:{scriptName:"__unknown__"},sum:{requests:10,cpuTimeUs:10_000}}))]);
      return api(fixture(q));
    });
    const f=await collect(config,now,fetcher as typeof fetch);expect(f.errors).toEqual([]);expect(()=>validateFrame(f)).not.toThrow();
    expect(f.points.filter(p=>p.product==="Workers")).toHaveLength(4);
    expect(f.points.find(p=>p.key==="Workers:app:cpu")).toMatchObject({amount:700,operations:500,efficiency:1.4});
    expect(f.points.find(p=>p.key==="Workers:__unknown__:requests")?.amount).toBe(20);
    expect(f.points.find(p=>p.label.includes("ListParts"))?.efficiency).toBeCloseTo(100/520);
  });

  it("collects fixed batch queries and only persists SQL fingerprints",async()=>{
    const fetcher=mockFetch();const f=await collect(config,now,fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(8);expect(f.errors).toEqual([]);expect(f.completeQueries).toBe(true);
    expect(JSON.stringify(f)).not.toContain("private-user");expect(JSON.stringify(f)).not.toContain("SELECT");
    expect(f.points.find(p=>p.label.includes("ListParts"))?.usd).toBeCloseTo(0.00045);
    expect(f.points.find(p=>p.label==="CPU")?.amount).toBe(100);
    expect(f.points.find(p=>p.label==="KV write")?.usd).toBeCloseTo(0.0005);
    expect(f.at%300_000).toBe(0);expect(f.at).toBeLessThan(now-600_000);
  });
  it("does not mark a failed source healthy or recover missing data",async()=>{
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const q=JSON.parse(String(init?.body)).query;
      return q.includes("d1Analytics")?Response.json({errors:[{message:"private error"}]}):api(fixture(q));
    });
    const f=await collect(config,now,fetcher as typeof fetch);expect(f.healthy).not.toContain("D1");expect(f.errors).toContain("D1: collection unavailable");expect(JSON.stringify(f)).not.toContain("private error");
  });
  it("rejects a truncated result instead of silently dropping resources",async()=>{
    const fetcher=vi.fn(async()=>api(Array.from({length:128},()=>({dimensions:{},sum:{}}))));
    const f=await collect(config,now,fetcher as typeof fetch);expect(f.healthy).toEqual([]);expect(f.errors.length).toBe(8);
  });
  it("aggregates normalized SQL variants before calculating per-query amplification",async()=>{
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const q=JSON.parse(String(init?.body)).query,rows=fixture(q);
      if(q.includes("d1Queries"))rows.push({count:100,dimensions:{databaseId:"core",query:"SELECT * FROM sensitive WHERE username='another-user'"},sum:{rowsRead:38_000_000,rowsWritten:0,rowsReturned:1}});
      return api(rows);
    });
    const f=await collect(config,now,fetcher as typeof fetch);const p=f.points.filter(p=>p.diagnostic);expect(p).toHaveLength(1);expect(p[0].operations).toBe(200);expect(p[0].efficiency).toBe(380_000);
  });
  it("reconciles reported daily charges across all products separately from estimates",async()=>{
    const start=new Date(now-2*86400_000).toISOString(),end=new Date(now-86400_000).toISOString();
    const fetcher=vi.fn(async()=>Response.json({success:true,result:[{ChargePeriodStart:start,ChargePeriodEnd:end,BillingCurrency:"USD",ServiceName:"Containers",EffectiveCost:12},{ChargePeriodStart:start,ChargePeriodEnd:end,BillingCurrency:"USD",ServiceName:"Email",EffectiveCost:1}]}));
    const p=await billable(config,now,fetcher as typeof fetch);expect(p[0].key).toBe("Billing:account:daily");expect(p[0].amount).toBe(13);expect(p[0].label).toContain("Containers");
  });
});
