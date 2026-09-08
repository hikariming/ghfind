#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validateManifest, ACCOUNT } from "./feed-platform-manifest.mjs";

const manifest = validateManifest(
  JSON.parse(readFileSync(process.argv[2], "utf8")),
);
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
async function get(path) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`Resource read rejected: ${path} HTTP ${response.status}`);
  const data = await response.json();
  if (data.success !== true) throw new Error(`Resource read failed: ${path}`);
  return data.result;
}
for (const field of ["coreDatabase", "feedDatabase"]) {
  const resource = await get(`/d1/database/${manifest[field].id}`);
  if (resource.name !== manifest[field].name)
    throw new Error(`Remote ${field} name/ID mismatch`);
}
const bucket = await get(`/r2/buckets/${manifest.archiveBucket}`);
if (bucket.name !== manifest.archiveBucket)
  throw new Error("Archive bucket mismatch");
for (const name of [manifest.queue, manifest.deadLetterQueue]) {
  const queues = await get(`/queues?name=${encodeURIComponent(name)}`);
  if (
    !Array.isArray(queues) ||
    queues.filter((q) => q.queue_name === name).length !== 1
  )
    throw new Error(`Queue missing or ambiguous: ${name}`);
}
console.log(
  "Verified isolated D1 names/IDs, archive bucket, main queue and DLQ in the pinned account",
);
