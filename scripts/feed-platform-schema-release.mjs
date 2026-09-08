import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const account = '8f19bebe359e4ec1a24c68c5f49c1584';
const targets = {
  production: ['ghfind', 'ghfind-feed', '9c4ac13a-4c90-40a8-9d56-d7141f864bbf'],
  dev: ['ghfind-dev', 'ghfind-feed-dev', 'bd305af9-2cab-4fe8-8c2f-324391cf105e'],
};

// Application merges must not silently apply the independently staged Feed
// schemas to production or to dev's shared production core database.
export async function approvedSchemas(manifest, repository = root) {
  if (manifest.version !== 1 || Object.keys(manifest).sort().join() !== 'core,feed,version') throw new Error('invalid schema release manifest');
  const checked = {};
  for (const [kind, directory] of [['core', 'migrations'], ['feed', 'migrations-feed']]) {
    const entries = manifest[kind];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 1000) throw new Error('explicit approved migrations required');
    const names = new Set();
    checked[kind] = [];
    for (const entry of entries) {
      if (Object.keys(entry).sort().join() !== 'name,sha256' || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256) || names.has(entry.name)) throw new Error('invalid or repeated migration approval');
      names.add(entry.name);
      const sql = await readFile(join(repository, directory, entry.name));
      if (createHash('sha256').update(sql).digest('hex') !== entry.sha256) throw new Error(`approved migration changed: ${entry.name}`);
      checked[kind].push({ name: entry.name, sql });
    }
    if (entries.map(e => e.name).join() !== entries.map(e => e.name).sort().join()) throw new Error('approved migrations must be ordered');
  }
  return checked;
}

export async function renderSchemaRelease({ target, output, repository = root }) {
  if (!Object.hasOwn(targets, target)) throw new Error('explicit production or dev target required');
  const manifest = JSON.parse(await readFile(join(repository, 'ops/feed-application-schema-release.json'), 'utf8'));
  const checked = await approvedSchemas(manifest, repository);
  const directory = resolve(output);
  await mkdir(directory); // Must be new: never replace files in an existing directory.
  for (const kind of ['core', 'feed']) {
    await mkdir(join(directory, kind));
    for (const entry of checked[kind]) await writeFile(join(directory, kind, entry.name), entry.sql, { flag: 'wx' });
  }
  const [name, feedName, feedID] = targets[target];
  const config = { name, account_id: account, compatibility_date: '2026-09-08', d1_databases: [
    { binding: 'GHFIND_D1', database_name: 'ghfind', database_id: '60d45096-bfe7-4de1-8b85-c1b66a466b0d', migrations_dir: join(directory, 'core') },
    { binding: 'GHFIND_FEED_D1', database_name: feedName, database_id: feedID, migrations_dir: join(directory, 'feed') },
  ] };
  const path = join(directory, 'wrangler.json');
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [target, output, ...extra] = process.argv.slice(2);
  if (!target || !output || extra.length) throw new Error('usage: feed-platform-schema-release.mjs production|dev NEW_OUTPUT_DIRECTORY');
  console.log(await renderSchemaRelease({ target, output }));
}
