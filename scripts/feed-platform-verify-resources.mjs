#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest, ACCOUNT } from "./feed-platform-manifest.mjs";

export async function verifyResources(manifest, { token, fetcher = fetch }) {
  validateManifest(manifest);
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  async function get(path) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error(
        `Resource read rejected: ${path} HTTP ${response.status}`,
      );
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
  const queueIdentities = [];
  for (const name of [
    manifest.queue,
    manifest.deadLetterQueue,
    manifest.terminalParkingQueue,
  ]) {
    const queues = await get(`/queues?name=${encodeURIComponent(name)}`);
    if (
      !Array.isArray(queues) ||
      queues.filter((q) => q.queue_name === name).length !== 1
    )
      throw new Error(`Queue missing or ambiguous: ${name}`);
    const queue = queues.find((q) => q.queue_name === name);
    if (!/^[a-f0-9]{32}$/.test(queue.queue_id)) throw new Error("Invalid queue identity");
    queueIdentities.push({ name, id: queue.queue_id });
    if (name === manifest.terminalParkingQueue) {
      if (!/^[a-f0-9]{32}$/.test(queue.queue_id))
        throw new Error("Invalid terminal parking identity");
      const details = await get(`/queues/${queue.queue_id}`);
      if (
        details.queue_name !== name ||
        details.queue_id !== queue.queue_id ||
        details.settings?.message_retention_period !== 1209600 ||
        !Array.isArray(details.consumers) ||
        details.consumers.length !== 0
      )
        throw new Error(
          "Terminal parking must have verified 14-day retention and no automatic consumer",
        );
    }
  }
  return {
    verified: true,
    accountId: ACCOUNT,
    environment: "staging",
    terminalParkingQueue: manifest.terminalParkingQueue,
    retentionSeconds: 1209600,
    queueIdentities,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await verifyResources(JSON.parse(readFileSync(process.argv[2], "utf8")), {
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    console.log(
      "Verified isolated D1 names/IDs, archive bucket, main queue, DLQ and terminal parking retention in the pinned account",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
