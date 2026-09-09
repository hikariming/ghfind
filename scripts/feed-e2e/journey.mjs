import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

export const MILESTONES = ['oauthCallback', 'assessmentFinalization', 'sourceOutbox', 'executorProjection', 'governance', 'preferences', 'events', 'deletionCompleted'];

/** Browser fetch retains actual HttpOnly OAuth cookies; no cookie is minted here. */
export async function browserCall(page, method, path, body, expected = 200, extraHeaders = {}) {
  const result = await page.evaluate(async ({ method, path, body, extraHeaders }) => {
    const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, noStore: response.headers.get('cache-control'), value: await response.json() };
  }, { method, path, body, extraHeaders });
  assert.equal(result.status, expected, `${method} ${path.split('?')[0]} failed: ${result.value?.error ?? 'unexpected_response'}`);
  if (path.startsWith('/api/feed/')) assert.equal(result.noStore, 'no-store');
  return result.value;
}

export async function runBusinessJourney({ page, other, submitRepositories, drain, governance, cleanup, inspect, milestone }) {
  const analyses = new Map();
  for (const repo of submitRepositories) {
    const created = await browserCall(page, 'POST', '/api/project-analyses', { repositoryUrl: `https://github.com/${repo}` }, 202);
    let completed;
    for (let attempt = 0; attempt < 8; attempt++) {
      completed = await browserCall(page, 'GET', created.statusUrl);
      if (completed.status === 'completed') break;
      assert(!['failed', 'expired', 'cancelled'].includes(completed.status), 'assessment reached terminal failure');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(completed.status, 'completed');
    analyses.set(repo, created.analysisId);
  }
  milestone.assessmentFinalization = true;
  await drain();
  const source = await inspect();
  assert.equal(source.source.completed, submitRepositories.length);
  assert.equal(source.source.assessments, submitRepositories.length);
  assert.equal(source.source.receipts, submitRepositories.length);
  assert.equal(source.source.outbox, submitRepositories.length);
  assert.equal(source.source.delivered, submitRepositories.length);
  assert.equal(source.queue.published, submitRepositories.length);
  assert.equal(source.queue.acknowledged, submitRepositories.length);
  assert.equal(source.queue.redelivered, submitRepositories.length);
  assert.equal(source.queue.pending, 0);
  milestone.sourceOutbox = true;
  let first = await browserCall(page, 'GET', '/api/feed/projects?limit=1');
  assert.equal(first.items.length, 1);
  assert(first.nextCursor, 'snapshot must retain next page');
  const item = first.items[0];
  assert(analyses.has(item.project.repoKey));
  for (const privateField of ['analysisId', 'sourceHash', 'score', 'features', 'propensity', 'embedding', 'candidateSources']) assert(!JSON.stringify(first).includes(`"${privateField}":`), `private field leaked: ${privateField}`);
  const event = { id: randomUUID(), type: 'impression', repoKey: item.project.repoKey, impressionToken: item.impressionToken, occurredAt: new Date().toISOString() };
  await browserCall(page, 'POST', '/api/feed/events', { events: [event] }, 202);
  const second = await browserCall(page, 'GET', `/api/feed/projects?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].project.repoKey, item.project.repoKey, 'impression invalidated or repeated snapshot page');
  milestone.executorProjection = true;

  // Authenticated client attempts to override the OAuth subject. The gateway
  // must discard these headers and leave the second identity's preferences empty.
  const before = await browserCall(page, 'GET', '/api/feed/preferences');
  const path = `/api/feed/projects/${item.project.repoKey}/state`;
  await browserCall(other, 'PUT', path, { saved: true, impressionToken: item.impressionToken }, 400);
  await browserCall(page, 'PUT', path, { saved: true, impressionToken: item.impressionToken }, 200, { 'x-github-id': '4243', 'x-feed-gateway': 'forged', authorization: 'Bearer forged' });
  const savedProfile = await browserCall(page, 'GET', '/api/feed/preferences');
  assert(savedProfile.profileVersion > before.profileVersion, 'save did not affect profile version');
  assert(savedProfile.preferences.some(preference => preference.value > 0 && preference.source !== 'explicit'), 'save did not produce a behavior signal');
  const otherProfile = await browserCall(other, 'GET', '/api/feed/preferences');
  assert.equal(otherProfile.preferences.length, 0, 'forged identity modified other user');
  event.id = randomUUID(); event.type = 'github_outbound';
  await browserCall(page, 'POST', '/api/feed/events', { events: [event] }, 202);
  const duplicate = await browserCall(page, 'POST', '/api/feed/events', { events: [event] }, 202);
  assert.equal(duplicate.accepted, 0); assert.equal(duplicate.duplicate, 1);
  milestone.events = true;

  const proposal = await browserCall(page, 'POST', '/api/feed/tags/proposals', { id: randomUUID(), repoKey: item.project.repoKey, namespace: 'domain', slug: 'e2e-reviewed-tool', labelZh: '本地治理测试', labelEn: 'Local governance fixture', evidence: ['readme-contract'] }, 202);
  assert.equal(proposal.status, 'proposed');
  const tags = await browserCall(page, 'GET', '/api/feed/tags');
  const command = { commandId: randomUUID(), writerEpoch: 1, expectedTaxonomyVersion: tags.taxonomyVersion, operator: 'local-e2e-governor', reason: 'Review isolated fixture evidence', proposalKind: 'user', proposalId: proposal.proposalId, expectedAnalysisId: analyses.get(item.project.repoKey), action: 'create', labels: { labelZh: '本地治理测试', labelEn: 'Local governance fixture', description: 'Explicit isolated human-review transport fixture' }, assignment: { weight: 1, confidence: .9 } };
  await governance('review', command, false, 401);
  const reviewed = await governance('review', command, true, 200);
  assert.equal(reviewed.status, 'mapped');
  assert.equal(reviewed.taxonomyVersion, tags.taxonomyVersion + 1);
  assert.deepEqual(await governance('review', command, true, 200), reviewed, 'governance replay changed result');
  milestone.governance = true;
  await browserCall(page, 'PUT', '/api/feed/preferences', { taxonomyVersion: reviewed.taxonomyVersion, preferences: [{ tagId: reviewed.canonicalTagId, value: -2 }] });
  const filtered = await browserCall(page, 'GET', '/api/feed/projects?limit=20');
  assert(filtered.items.every(candidate => candidate.project.repoKey !== item.project.repoKey), 'explicit negative preference did not filter reviewed project');
  await browserCall(page, 'PUT', '/api/feed/preferences', { taxonomyVersion: reviewed.taxonomyVersion, preferences: [] });
  const available = await browserCall(page, 'GET', '/api/feed/projects?limit=20');
  assert(available.items.some(candidate => candidate.project.repoKey === item.project.repoKey), 'clearing negative preference did not restore eligibility');
  milestone.preferences = true;

  const current = available.items.find(candidate => candidate.project.repoKey === item.project.repoKey);
  const erased = await browserCall(page, 'DELETE', '/api/feed/profile', undefined, 202);
  assert.equal(erased.status, 'queued');
  await browserCall(other, 'GET', `/api/feed/profile/deletions/${erased.deletionId}`, undefined, 404);
  await browserCall(page, 'PUT', path, { saved: true, impressionToken: current.impressionToken }, 400);
  let status;
  for (let attempt = 0; attempt < 16; attempt++) {
    await cleanup();
    status = await browserCall(page, 'GET', `/api/feed/profile/deletions/${erased.deletionId}`);
    if (status.status === 'completed') break;
    assert(!['failed', 'blocked'].includes(status.status), 'deletion cleanup failed');
  }
  assert.equal(status.status, 'completed', 'deletion must finish all required cleanup');
  milestone.deletionCompleted = true;
  return { repositories: submitRepositories.length, source: await inspect(), deletionStatus: status.status };
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const origin = `http://127.0.0.1:${config.webPort}`;
  const report = { format: 'ghfind-complete-local-journey-v1', sourceSha: config.sourceSha, sourceTree: config.sourceTree, profile: config.profile, status: 'failed', realOAuth: false, externalProviders: 'local-fixture-transports', milestones: Object.fromEntries(MILESTONES.map(key => [key, false])) };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const login = async (code) => {
      const context = await browser.newContext();
      // This is only GitHub's external authorize page. State was issued by the
      // application and the callback must exchange the returned code itself.
      await context.route('https://github.com/login/oauth/authorize**', async route => {
        const authorize = new URL(route.request().url());
        assert.equal(authorize.searchParams.get('client_id'), 'local-e2e-oauth');
        assert.equal(authorize.searchParams.get('redirect_uri'), `${origin}/api/auth/callback/github`);
        const callback = new URL(authorize.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', authorize.searchParams.get('state'));
        callback.searchParams.set('code', code);
        await route.fulfill({ status: 302, headers: { location: callback.href } });
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || (url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize')) return route.fallback();
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      await page.goto(`${origin}/api/feed/projects`);
      await browserCall(page, 'GET', '/api/feed/projects', undefined, 401);
      await page.goto(`${origin}/api/auth/github?callbackUrl=/api/feed/preferences`);
      await page.waitForURL(`${origin}/api/feed/preferences`);
      const cookies = await context.cookies(origin);
      assert(cookies.some(cookie => cookie.name === 'ghfind_session' && cookie.httpOnly), 'real OAuth callback did not issue HttpOnly session');
      assert(!cookies.some(cookie => cookie.name === 'ghfind_oauth_state'), 'state cookie not cleared after exchange');
      await browserCall(page, 'GET', '/api/feed/preferences');
      return page;
    };
    const page = await login('local-ordinary'), other = await login('local-governor');
    report.milestones.oauthCallback = true;
    const control = async (path) => {
      const response = await fetch(`http://127.0.0.1:${config.controlPort}${path}`, { method: 'POST', headers: { authorization: `Bearer ${config.owner}` } });
      assert.equal(response.status, 200); return response.json();
    };
    const operatorOrigin = `http://127.0.0.1:${config.profile === 'postgres' ? config.executorPort : config.adapterPort}`;
    const governance = async (operation, body, authorized, expected) => {
      const response = await fetch(`${operatorOrigin}/internal/feed/governance/v1/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${authorized ? process.env.FEED_OPERATOR_SECRET : 'forged-user-key'}`, 'x-feed-contract': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, expected, `governance ${operation}: ${JSON.stringify(result)}`); return result;
    };
    const cleanup = async () => {
      const response = await fetch(`http://127.0.0.1:${config.executorPort}/internal/feed/jobs/cleanup`, { method: 'POST', headers: { authorization: `Bearer ${process.env.FEED_EXECUTOR_SECRET}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200); return response.json();
    };
    report.result = await runBusinessJourney({ page, other, submitRepositories: ['e2e-owner-one/tool-one', 'e2e-owner-two/tool-two', 'e2e-owner-three/tool-three'], drain: () => control('/drain'), inspect: () => control('/inspect'), governance, cleanup, milestone: report.milestones });
    assert.equal(report.result.source.providers.oauthTokenExchange, 2);
    assert.equal(report.result.source.providers.oauthProfile, 2);
    assert.equal(report.result.source.providers.assessmentCreate, 3);
    assert.equal(report.result.source.providers.artifactDownloads, 9);
    assert.equal(report.result.source.providers.unexpectedExternal, 0);
    for (const key of MILESTONES) assert.equal(report.milestones[key], true);
    report.status = 'passed';
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'journey_failed';
    console.error(error); process.exitCode = 1;
  } finally {
    await browser?.close();
    await writeFile(`${config.directory}/journey.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
}
if (process.argv[1]?.endsWith('/journey.mjs')) await main();
