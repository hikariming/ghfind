#!/usr/bin/env node
// A trusted build-chain receipt, not a claim of hardware remote attestation.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateImage } from './feed-platform-manifest.mjs';

export function imageProof(image, binaries, env = process.env) {
  validateImage(image);
  const sourceSha = env.RELEASE_SHA, imageBuildId = env.FEED_IMAGE_BUILD_ID;
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[a-f0-9]{64}$/.test(imageBuildId ?? '') ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''))
    throw new Error('exact build identity and Actions attempt required');
  if (!Array.isArray(binaries) || binaries.length !== 2) throw new Error('both compiled entrypoints required');
  for (const service of ['feed-api', 'feed-worker']) {
    const rows = binaries.filter(b => b?.service === service), b = rows[0];
    if (rows.length !== 1 || Object.keys(b).sort().join(',') !== 'imageBuildId,service,version' ||
        b.version !== sourceSha || b.imageBuildId !== imageBuildId)
      throw new Error('compiled image identity differs');
  }
  return { format: 'ghfind-feed-image-build-v1', sourceSha, image, imageBuildId,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    services: ['feed-api','feed-worker'], observedAt: new Date().toISOString() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [image, directory] = process.argv.slice(2);
  if (!image || !directory || process.argv.length !== 4) throw new Error('image proof requires digest and evidence directory');
  const binaries = ['api','worker'].map(role => JSON.parse(readFileSync(join(directory, `image-${role}.json`), 'utf8')));
  writeFileSync(join(directory,'image-build.json'), JSON.stringify(imageProof(image,binaries),null,2)+'\n', { mode:0o600, flag:'wx' });
}
