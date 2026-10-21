import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes,createCipheriv,publicEncrypt,constants} from "node:crypto";
export function encryptPreview(html,publicKey){
  const key=randomBytes(32),iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  const ciphertext=Buffer.concat([cipher.update(html,"utf8"),cipher.final()]);
  return JSON.stringify({version:1,key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key).toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")});
}
async function main(){
  const base=process.env.COST_MONITOR_URL;
  if(!base||!process.env.MONITOR_ADMIN_TOKEN||!process.env.TRAFFIC_PREVIEW_PUBLIC_KEY)throw new Error("Missing preview configuration");
  const response=await fetch(`${base.replace(/\/$/,"")}/traffic-report/preview`,{method:"POST",headers:{authorization:`Bearer ${process.env.MONITOR_ADMIN_TOKEN}`},signal:AbortSignal.timeout(120_000)});
  if(!response.ok)throw new Error(`Traffic preview HTTP ${response.status}`);
  const html=await response.text();
  if(!html.includes("流量日报")||!html.includes("全部请求量 · 7 天")||!html.includes('name="color-scheme" content="light only"')||!/<title>\[ghfind\]\[流量日报\] \d{2}-\d{2}→\d{2}-\d{2} · 访客/.test(html))throw new Error("Traffic preview is invalid or still serving an older release");
  // This repository is public. Only ciphertext may leave the authenticated
  // preview request; the owner keeps the corresponding private key locally.
  await fs.writeFile(path.join(process.env.RUNNER_TEMP??"/tmp","ghfind-traffic-preview.encrypted.json"),encryptPreview(html,process.env.TRAFFIC_PREVIEW_PUBLIC_KEY));
  console.log(JSON.stringify({event:"traffic_preview_saved_encrypted",bytes:Buffer.byteLength(html),hasVisitorData:/24h 访客 [\d,]+/.test(html)}));
  const health=await fetch(`${base.replace(/\/$/,"")}/health`,{headers:{authorization:`Bearer ${process.env.MONITOR_ADMIN_TOKEN}`},signal:AbortSignal.timeout(30_000)}).then(r=>r.json());
  console.log(JSON.stringify({event:"traffic_schedule_verified",nextTrafficReport:health.nextTrafficReport,lastTrafficError:health.lastTrafficError,heartbeatHealthy:health.heartbeatHealthy,lastBilling:health.lastBilling,lastBillingAttempt:health.lastBillingAttempt,lastBillingError:health.lastBillingError}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
