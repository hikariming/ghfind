import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { approvedSchemas, renderSchemaRelease } from './feed-platform-schema-release.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'ops/feed-application-schema-release.json'), 'utf8'));
test('legacy application release only exposes explicitly approved hashes, excluding new portable migrations', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'feed-schema-release-'));
  try {
    for (const target of ['production', 'dev']) {
      const output = join(temp, target);
      const config = JSON.parse(await readFile(await renderSchemaRelease({ target, output }), 'utf8'));
      assert.equal(config.account_id, '8f19bebe359e4ec1a24c68c5f49c1584');
      assert.equal(config.d1_databases[0].database_id, '60d45096-bfe7-4de1-8b85-c1b66a466b0d');
      assert.deepEqual(await readdir(join(output, 'feed')), manifest.feed.map(e => e.name));
      assert.deepEqual(await readdir(join(output, 'core')), manifest.core.map(e => e.name));
      assert.ok(!(await readdir(join(output, 'feed'))).includes('0003_feed_runtime_contract.sql'));
      assert.ok(!(await readdir(join(output, 'core'))).includes('0005_feed_source_outbox.sql'));
      await assert.rejects(renderSchemaRelease({ target, output }), /EEXIST/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('changed hashes, path traversal, duplicate approvals and unknown targets fail before rendering', async () => {
  for (const modify of [m => m.core[0].sha256 = '0'.repeat(64), m => m.feed[0].name = '../0001.sql', m => m.feed.push(m.feed[0])]) {
    const copy = structuredClone(manifest); modify(copy);
    await assert.rejects(approvedSchemas(copy));
  }
  await assert.rejects(renderSchemaRelease({ target: 'staging', output: '/unused' }), /explicit/);
});
