#!/usr/bin/env node
// Read-only, bounded checks. A passing OAuth redirect is not a login journey.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ACCOUNT } from "./feed-platform-manifest.mjs";
import { coreManifest, validateWebManifest, renderWeb, WEB_WORKER, WEB_CACHE } from "./feed-platform-web.mjs";
import { verifyResources } from "./feed-platform-verify-resources.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export async function boundedJSON(response, maximum = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error("oversized platform response");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("invalid platform JSON response"); }
}
function platformReader(token, fetcher) {
  if (!token) throw new Error("dedicated Cloudflare token required");
  return async path => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: "error",
    });
    if (!response.ok) throw new Error(`platform read rejected HTTP ${response.status}`);
    const data = await boundedJSON(response);
    if (data.success !== true) throw new Error("platform read failed");
    return data.result;
  };
}
export async function verifyWebResources(m, { token, fetcher = fetch }) {
  validateWebManifest(m);
  const basic = await verifyResources(coreManifest(m), { token, fetcher });
  const get = platformReader(token, fetcher);
  const bucket = await get(`/r2/buckets/${WEB_CACHE}`);
  if (bucket.name !== WEB_CACHE) throw new Error("isolated Web cache bucket missing");
  const account = await get("/workers/subdomain");
  if (m.web.origin !== `https://${WEB_WORKER}.${account.subdomain}.workers.dev`) throw new Error("workers.dev subdomain is not the pinned account's subdomain");
  return { ...basic, webWorker: WEB_WORKER, webCacheBucket: WEB_CACHE, webOrigin: m.web.origin,
    coreDatabaseId: m.coreDatabase.id, feedDatabaseId: m.feedDatabase.id, archiveBucket: m.archiveBucket,
    runtimeWorker: m.runtimeWorker, adapterWorker: m.adapterWorker, queue: m.queue, deadLetterQueue: m.deadLetterQueue,
    observedAt: new Date().toISOString() };
}
export function verifyWebVersion(m, sha, active, version) {
  const config = renderWeb(m, sha);
  const deployment = active?.deployments?.[0]; // API: first entry is actively serving.
  if (!deployment || !uuid.test(deployment.id) || deployment.versions?.length !== 1 ||
      deployment.versions[0].percentage !== 100 || !uuid.test(deployment.versions[0].version_id) ||
      version?.id !== deployment.versions[0].version_id || version.annotations?.["workers/tag"] !== `staging-${sha}`)
    throw new Error("Web active deployment/version/tag mismatch");
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings) || new Set(bindings.map(b => b.name)).size !== bindings.length) throw new Error("invalid Web binding inventory");
  const expected = [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...config.secrets.required.map(name => ({ name, type: "secret_text" })),
    ...config.d1_databases.map(b => ({ name: b.binding, type: "d1", id: b.database_id })),
    ...config.r2_buckets.map(b => ({ name: b.binding, type: "r2_bucket", bucket_name: b.bucket_name })),
    ...config.services.map(b => ({ name: b.binding, type: "service", service: b.service })),
    { name: "ASSETS", type: "assets" }, { name: "WORKER_VERSION", type: "version_metadata" },
  ];
  if (bindings.length !== expected.length) throw new Error("unexpected Web binding present or required binding missing");
  for (const item of expected) {
    const actual = bindings.find(b => b.name === item.name);
    if (!actual || Object.entries(item).some(([key, value]) => actual[key] !== value)) throw new Error(`Web binding mismatch: ${item.name}`);
    if (item.type === "service" && (actual.entrypoint !== undefined || (actual.environment !== undefined && actual.environment !== "production"))) throw new Error("Web runtime service target changed");
  }
  if (version.resources?.script_runtime?.compatibility_date !== config.compatibility_date ||
      !version.resources.script_runtime.compatibility_flags?.includes("nodejs_compat") ||
      typeof version.resources.script?.etag !== "string" || !version.resources.script.etag) throw new Error("Web script runtime/etag missing");
  return { worker: WEB_WORKER, deploymentId: deployment.id, versionId: version.id,
    tag: version.annotations["workers/tag"], scriptEtag: version.resources.script.etag,
    bindingIdentitySHA256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    sourceSha: sha, bindingsVerified: true };
}
export async function verifyWebDeployment(m, sha, { token, fetcher = fetch }) {
  validateWebManifest(m);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("exact source SHA required");
  const get = platformReader(token, fetcher);
  const active = await get(`/workers/scripts/${WEB_WORKER}/deployments`);
  const id = active?.deployments?.[0]?.versions?.[0]?.version_id;
  if (!uuid.test(id)) throw new Error("active Web version missing");
  const version = await get(`/workers/scripts/${WEB_WORKER}/versions/${id}`);
  const identity = verifyWebVersion(m, sha, active, version);
  const exposure = await get(`/workers/scripts/${WEB_WORKER}/subdomain`);
  if (exposure.enabled !== true || exposure.previews_enabled !== false) throw new Error("Web workers.dev/preview exposure differs");
  const redirect = await fetcher(new URL("/api/auth/github?callbackUrl=/feed", m.web.origin), { redirect: "manual", signal: AbortSignal.timeout(15000) });
  let oauth;
  try { oauth = new URL(redirect.headers.get("location")); } catch { throw new Error("OAuth begin redirect missing"); }
  if (redirect.status !== 302 || oauth.origin !== "https://github.com" || oauth.pathname !== "/login/oauth/authorize" ||
      oauth.searchParams.get("client_id") !== m.web.oauth.clientId || oauth.searchParams.get("redirect_uri") !== m.web.oauth.callbackUrl ||
      !oauth.searchParams.get("state") || oauth.searchParams.get("scope") !== "read:user") throw new Error("OAuth begin configuration mismatch");
  // Discard provider state and Set-Cookie. Never retain a redirect URL or cookie.
  void redirect.body?.cancel().catch(() => {});
  const anonymous = await fetcher(new URL("/api/feed/projects", m.web.origin), { redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (anonymous.status !== 401 || anonymous.headers.get("cache-control") !== "no-store") throw new Error("Web anonymous Feed boundary failed");
  void anonymous.body?.cancel().catch(() => {});
  const after = await get(`/workers/scripts/${WEB_WORKER}/deployments`);
  if (after.deployments?.[0]?.id !== identity.deploymentId) throw new Error("Web deployment changed during probe");
  return { format: "ghfind-feed-web-deployment-v1", status: "passed", observedAt: new Date().toISOString(),
    sourceSha: sha, origin: m.web.origin, ...identity, oauthBeginVerified: true, anonymousFeedRejected: true,
    realOAuth: false, note: "Configuration/readback only. Actual two-identity OAuth journey is a separate required gate." };
}
async function main(args) {
  const [command, path, shaOrOutput, output] = args;
  const m = JSON.parse(readFileSync(path, "utf8"));
  const result = command === "resources" && args.length === 3
    ? await verifyWebResources(m, { token: process.env.CLOUDFLARE_API_TOKEN })
    : command === "deployment" && args.length === 4
      ? await verifyWebDeployment(m, shaOrOutput, { token: process.env.CLOUDFLARE_API_TOKEN }) : null;
  if (!result) throw new Error("usage: feed-platform-web-verify.mjs resources MANIFEST OUTPUT | deployment MANIFEST SHA OUTPUT");
  writeFileSync(output ?? shaOrOutput, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(command === "resources" ? "Isolated resources read back" : "Web active deployment and OAuth configuration verified; no real login claimed");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
