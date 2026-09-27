import "./_env.mjs";
import { devscoreScan } from "./devscore-scan.mts";
import { publishCompleteQuickScan } from "../src/lib/db";
import type { ScanResult } from "../src/lib/types";

const users = process.argv.slice(2);
if (!users.length) { console.error("usage: ingest-devs.mts <user...>"); process.exit(1); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < users.length; i++) {
  const u = users[i];
  if (i > 0) await sleep(2000);
  try {
    const scan: ScanResult = await devscoreScan(u);
    const { scoring, organizations } = scan;
    const scoreWrite = await publishCompleteQuickScan(scan);
    if (!scoreWrite) throw new Error("scan requires durable collection or storage is unavailable");
    const orgs = organizations ?? [];
    const hasLg = orgs.some((o) => o.toLowerCase() === "langgenius");
    console.log(`OK  ${scan.metrics.username.padEnd(16)} score=${String(scoring.final_score).padStart(5)} ${scoring.tier.padEnd(6)} langgenius=${hasLg?"YES":"no "} orgs=[${orgs.join(",")}]`);
  } catch (e) {
    console.log(`ERR ${u.padEnd(16)} ${e instanceof Error ? e.message : String(e)}`);
  }
}
