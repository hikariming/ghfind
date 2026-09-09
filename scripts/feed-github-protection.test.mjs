import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPlan, buildPlan, captureState, environmentTargets, hash, owner, repository, rulesetId, validatePRChecks, verifyExisting, verifyExistingState } from './feed-github-protection.mjs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function server() {
  const data = {
    admin: true,
    ruleset: { id: rulesetId, name: 'Protect main', target: 'branch', source_type: 'Repository', source: repository, enforcement: 'active', bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: true, require_last_push_approval: true, required_review_thread_resolution: false, require_extra_approval_for_unattributed_changes: true, required_reviewers: [], allowed_merge_methods: ['merge', 'squash', 'rebase'] } }] },
    environments: { Production: { name: 'Production', can_admins_bypass: true, protection_rules: [], deployment_branch_policy: null } },
    policies: {}, writes: [], reads: [], failNextWrite: null,
  };
  const request = async (method, path, body) => {
    if (method === 'GET') data.reads.push(path);
    else {
      if (data.failNextWrite?.(method, path)) { const error = new Error('Must have admin rights to Repository'); error.code = 'ADMIN_REQUIRED'; throw error; }
      data.writes.push({ method, path, body: clone(body) });
    }
    if (path === `/repos/${repository}`) return { full_name: repository, default_branch: 'main', owner, permissions: { admin: data.admin } };
    if (path === `/users/${owner.login}`) return owner;
    if (path.endsWith(`/rulesets/${rulesetId}`)) { if (method === 'PUT') Object.assign(data.ruleset, clone(body)); return clone(data.ruleset); }
    if (path.includes('/environments?')) return { total_count: Object.keys(data.environments).length, environments: Object.values(data.environments).map(clone) };
    const parsed = new RegExp(`/environments/([^/?]+)(/deployment-branch-policies)?`).exec(path);
    assert.ok(parsed, `unexpected request ${method} ${path}`);
    const name = decodeURIComponent(parsed[1]);
    if (parsed[2]) {
      if (method === 'POST') (data.policies[name] ??= []).push({ id: data.writes.length, ...clone(body) });
      const policies = data.policies[name] ?? [];
      return { total_count: policies.length, branch_policies: clone(policies) };
    }
    if (method === 'PUT') {
      const previous = data.environments[name] ?? { name, can_admins_bypass: true, protection_rules: [], deployment_branch_policy: null };
      const rules = previous.protection_rules.filter(rule => !['wait_timer', 'required_reviewers', 'branch_policy'].includes(rule.type));
      if (body.wait_timer) rules.push({ type: 'wait_timer', wait_timer: body.wait_timer });
      if (body.reviewers.length) rules.push({ type: 'required_reviewers', prevent_self_review: body.prevent_self_review, reviewers: body.reviewers.map(reviewer => ({ type: reviewer.type, reviewer: { id: reviewer.id } })) });
      if (body.deployment_branch_policy.custom_branch_policies) rules.push({ type: 'branch_policy' });
      data.environments[name] = { ...previous, protection_rules: rules, deployment_branch_policy: clone(body.deployment_branch_policy) };
    }
    return clone(data.environments[name]);
  };
  return { data, request };
}

test('default discovery and plan use GET only; missing environment requires a complete readable list', async () => {
  const { data, request } = server();
  const state = await captureState(request), plan = buildPlan(state, workflow);
  assert.equal(data.writes.length, 0);
  assert.equal(state.environments['Feed staging'], null);
  assert.equal(plan.readyToApply, true);
  const badRequest = async (method, path) => path.includes('/environments?') ? { total_count: 101, environments: [] } : request(method, path);
  await assert.rejects(captureState(badRequest), /Complete environment inventory/);
  assert.equal(data.writes.length, 0);
});

test('ruleset plan preserves all merge options, bypass and review requirements while adding actual PR checks', async () => {
  const { data, request } = server();
  const plan = buildPlan(await captureState(request), workflow);
  const update = plan.operations.find(operation => operation.kind === 'ruleset').body;
  assert.deepEqual(update.bypass_actors, data.ruleset.bypass_actors);
  assert.deepEqual(update.conditions, data.ruleset.conditions);
  assert.deepEqual(update.rules.slice(0, 2), data.ruleset.rules.slice(0, 2));
  const before = data.ruleset.rules[2].parameters, after = update.rules[2].parameters;
  assert.deepEqual(after, before);
  assert.deepEqual(after.allowed_merge_methods, ['merge', 'squash', 'rebase']);
  const statuses = update.rules.find(rule => rule.type === 'required_status_checks').parameters;
  assert.equal(statuses.strict_required_status_checks_policy, true);
  assert.deepEqual(statuses.required_status_checks.map(check => check.context), ['Application checks', 'Feed storage contracts', 'Feed runtime builds', 'Complete local Feed E2E']);
  assert.ok(statuses.required_status_checks.every(check => check.integration_id === 15368));
});

test('environment plan restricts exact branches, protects operations, and adds no Production approval pause', async () => {
  const { request } = server();
  const plan = buildPlan(await captureState(request), workflow);
  for (const [name, branches] of Object.entries(environmentTargets)) {
    const configured = plan.operations.filter(operation => operation.kind === 'branch-policy' && operation.name === name).map(operation => operation.body);
    assert.deepEqual(configured, [...branches].sort().map(branch => ({ name: branch, type: 'branch' })));
  }
  const production = plan.operations.find(operation => operation.kind === 'environment' && operation.name === 'Production').body;
  assert.deepEqual(production.reviewers, []); assert.equal(production.wait_timer, 0);
  const operations = plan.operations.find(operation => operation.kind === 'environment' && operation.name === 'Feed staging operations').body;
  assert.deepEqual(operations.reviewers, [{ type: 'User', id: owner.id }]);
});

test('redacted bypass actors cannot be interpreted as none or written with non-admin credentials', async () => {
  const { data, request } = server(); data.admin = false; delete data.ruleset.bypass_actors;
  const state = await captureState(request), plan = buildPlan(state, workflow);
  assert.equal(Object.hasOwn(state.ruleset, 'bypass_actors'), false);
  assert.equal(plan.readyToApply, false);
  assert.ok(plan.blockers.some(reason => reason.includes('redacted')));
  await assert.rejects(applyPlan(plan, plan.currentHash, { request, workflow }), error => error.code === 'ADMIN_REQUIRED');
  assert.equal(data.writes.length, 0);
});

test('stale hashes, changed bodies and substituted repositories stop before any write', async () => {
  for (const mutate of [plan => { plan.operations[0].body.bypass_actors = []; }, plan => { plan.operations[0].path = '/repos/attacker/ghfind/rulesets/1'; }, plan => { plan.repository = 'attacker/ghfind'; }]) {
    const { data, request } = server(); const plan = buildPlan(await captureState(request), workflow); mutate(plan);
    await assert.rejects(applyPlan(plan, plan.currentHash, { request, workflow })); assert.equal(data.writes.length, 0);
  }
  const { data, request } = server(); const plan = buildPlan(await captureState(request), workflow);
  data.ruleset.rules[2].parameters.required_approving_review_count = 2;
  await assert.rejects(applyPlan(plan, plan.currentHash, { request, workflow }), error => error.code === 'STALE_PROTECTION_PLAN');
  assert.equal(data.writes.length, 0);
});

test('existing Production reviewers, wait timer and extra required checks remain unchanged', async () => {
  const { data, request } = server();
  data.environments.Production.protection_rules.push({ type: 'wait_timer', wait_timer: 10 }, { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 99 } }] });
  data.ruleset.rules.push({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Existing security check', integration_id: 88 }] } });
  const plan = buildPlan(await captureState(request), workflow);
  const production = plan.operations.find(operation => operation.kind === 'environment' && operation.name === 'Production').body;
  assert.equal(production.wait_timer, 10); assert.equal(production.prevent_self_review, true); assert.deepEqual(production.reviewers, [{ type: 'User', id: 99 }]);
  assert.ok(plan.notes.some(note => note.includes('existing reviewer/timer')));
  const statuses = plan.operations[0].body.rules.find(rule => rule.type === 'required_status_checks').parameters;
  assert.deepEqual(statuses.required_status_checks[0], { context: 'Existing security check', integration_id: 88 });
  assert.equal(statuses.do_not_enforce_on_create, true);
});

test('different reviewer alternatives, restricted branch policy or non-writable custom protection require manual drift resolution', async () => {
  for (const customize of [
    data => { data.environments.Production.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }; },
    data => { data.environments.Production.can_admins_bypass = false; },
    data => { data.environments.Production.protection_rules.push({ type: 'custom', app: { id: 42 } }); },
    data => { data.environments['Feed staging operations'] = { ...clone(data.environments.Production), name: 'Feed staging operations', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 99 } }] }] }; },
  ]) {
    const { data, request } = server(); customize(data); const plan = buildPlan(await captureState(request), workflow);
    assert.equal(plan.readyToApply, false); assert.ok(plan.blockers.some(reason => reason.startsWith('PROTECTION_DRIFT')));
    await assert.rejects(applyPlan(plan, plan.currentHash, { request, workflow })); assert.equal(data.writes.length, 0);
  }
});

test('applying a reviewed administrator plan verifies each write and is idempotent', async () => {
  const { data, request } = server(); const before = clone(data.ruleset.bypass_actors);
  const plan = buildPlan(await captureState(request), workflow);
  const result = await applyPlan(plan, plan.currentHash, { request, workflow });
  assert.equal(result.status, 'applied-and-verified'); assert.equal(result.completed.length, 8);
  assert.equal(result.finalHash, hash(await captureState(request)));
  assert.deepEqual(data.ruleset.bypass_actors, before);
  const next = buildPlan(await captureState(request), workflow); assert.deepEqual(next.operations, []);
  const count = data.writes.length; await applyPlan(next, next.currentHash, { request, workflow }); assert.equal(data.writes.length, count);
});

test('administrator write failure preserves verified tightening and records partial state without rollback', async () => {
  const { data, request } = server(); const plan = buildPlan(await captureState(request), workflow);
  data.failNextWrite = (_method, path) => path.includes('/environments/');
  await assert.rejects(applyPlan(plan, plan.currentHash, { request, workflow }), error => error.code === 'ADMIN_REQUIRED' && error.completed.length === 1 && error.message.includes('No automatic rollback'));
  assert.equal(data.writes.length, 1);
  assert.ok(data.ruleset.rules.some(rule => rule.type === 'required_status_checks'));
});

test('a push-only or optional full E2E job cannot be selected as a required PR status', () => {
  assert.throws(() => validatePRChecks(workflow.replace('    name: Complete local Feed E2E\n', "    name: Complete local Feed E2E\n    if: github.event_name == 'push'\n")), /mandatory PR job/);
  assert.throws(() => validatePRChecks(workflow.replace('    name: Complete local Feed E2E\n', '    name: Complete local Feed E2E\n    continue-on-error: true\n')), /mandatory PR job/);
});

test('a partial or broader existing custom branch policy is not silently expanded or removed', async () => {
  for (const policies of [[{ name: 'main', type: 'branch' }], [{ name: '*', type: 'branch' }], [{ name: 'main', type: 'tag' }]]) {
    const { data, request } = server();
    data.environments['Feed staging'] = { ...clone(data.environments.Production), name: 'Feed staging', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
    data.policies['Feed staging'] = policies;
    const plan = buildPlan(await captureState(request), workflow);
    assert.equal(plan.readyToApply, false);
    assert.ok(plan.blockers.some(reason => reason.includes('different nonempty branch policy')));
    await assert.rejects(applyPlan(plan, plan.currentHash, { request, workflow }));
    assert.equal(data.writes.length, 0);
  }
});

test('unrelated protection drift after a write stops the sequence instead of being adopted as the next baseline', async () => {
  const { data, request } = server();
  const plan = buildPlan(await captureState(request), workflow);
  const driftingRequest = async (method, path, body) => {
    const result = await request(method, path, body);
    if (method === 'PUT' && path.endsWith(`/rulesets/${rulesetId}`)) data.environments.Production.can_admins_bypass = false;
    return result;
  };
  await assert.rejects(applyPlan(plan, plan.currentHash, { request: driftingRequest, workflow }), error => error.code === 'STALE_PROTECTION_PLAN' && error.message.includes('Unrelated protection drift'));
  assert.equal(data.writes.length, 1);
});


async function configuredServer() {
  const fixture = server();
  const plan = buildPlan(await captureState(fixture.request), workflow);
  await applyPlan(plan, plan.currentHash, { request: fixture.request, workflow });
  fixture.data.writes = [];
  fixture.data.admin = false;
  delete fixture.data.ruleset.bypass_actors;
  return fixture;
}

test('verify-existing accepts enforced public policy using read-only non-admin access with redacted bypass actors', async () => {
  const { data, request } = await configuredServer();
  const report = await verifyExisting(request);
  assert.equal(report.status, 'passed');
  assert.equal(report.format, 'ghfind-github-protection-verification-v1');
  assert.equal(report.requiredChecks.length, 4);
  assert.deepEqual(report.mergeMethods, ['merge', 'squash', 'rebase']);
  assert.equal(data.writes.length, 0);
  assert.equal(JSON.stringify(report).includes('bypass_actors'), false);
});

test('rebase delivery preserves either existing merge policy and requires no settings write once configured', async () => {
  for (const methods of [['rebase'], ['merge', 'squash', 'rebase']]) {
    const { data, request } = server();
    data.ruleset.rules.find(rule => rule.type === 'pull_request').parameters.allowed_merge_methods = methods;
    const plan = buildPlan(await captureState(request), workflow);
    await applyPlan(plan, plan.currentHash, { request, workflow });
    const count = data.writes.length;
    const next = buildPlan(await captureState(request), workflow);
    assert.deepEqual(next.operations, []);
    await applyPlan(next, next.currentHash, { request, workflow });
    assert.equal(data.writes.length, count);
    assert.deepEqual((await verifyExisting(request)).mergeMethods, methods);
  }
});

test('planning and readback reject unavailable rebase without silently changing merge options', async () => {
  for (const methods of [undefined, [], ['squash'], ['merge', 'squash']]) {
    const { data, request } = await configuredServer();
    const parameters = data.ruleset.rules.find(rule => rule.type === 'pull_request').parameters;
    if (methods === undefined) delete parameters.allowed_merge_methods;
    else parameters.allowed_merge_methods = methods;
    const state = await captureState(request);
    assert.throws(() => buildPlan(state, workflow), /requested PR rebase merge must be allowed/);
    assert.throws(() => verifyExistingState(state), error => error.code === 'PROTECTION_NOT_ENFORCED' && /requested PR rebase merge/.test(error.message));
    assert.equal(data.writes.length, 0);
  }
});

test('verify-existing rejects missing or auto-created empty environments and every missing required check', async () => {
  const { request } = await configuredServer();
  const snapshot = await captureState(request);
  for (const name of Object.keys(environmentTargets)) {
    for (const value of [null, { name, can_admins_bypass: true, protection_rules: [], deployment_branch_policy: null, branch_policies: [] }]) {
      const state = clone(snapshot); state.environments[name] = value;
      assert.throws(() => verifyExistingState(state), error => error.code === 'PROTECTION_NOT_ENFORCED');
    }
  }
  for (let index = 0; index < 4; index++) {
    const state = clone(snapshot); state.ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.splice(index, 1);
    assert.throws(() => verifyExistingState(state), /Missing strict GitHub Actions required check/);
  }
});

test('verify-existing rejects inactive rules, weakened reviews, broad branches and alternative operations approvers', async () => {
  const { request } = await configuredServer(); const snapshot = await captureState(request);
  for (const mutate of [
    state => { state.ruleset.enforcement = 'disabled'; },
    state => { state.ruleset.rules.find(rule => rule.type === 'pull_request').parameters.require_last_push_approval = false; },
    state => { state.ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.strict_required_status_checks_policy = false; },
    state => { state.ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = 999; },
    state => { state.environments['Feed staging'].branch_policies.push({ name: '*', type: 'branch' }); },
    state => { state.environments.Production.branch_policies[0].type = 'tag'; },
    state => { state.environments['Feed staging operations'].protection_rules.find(rule => rule.type === 'required_reviewers').reviewers.push({ type: 'User', id: 99 }); },
  ]) { const state = clone(snapshot); mutate(state); assert.throws(() => verifyExistingState(state), error => error.code === 'PROTECTION_NOT_ENFORCED'); }
});

test('verify-existing preserves additional stricter rules and Production approval without needing administrator access', async () => {
  const { data, request } = await configuredServer();
  data.ruleset.rules.find(rule => rule.type === 'pull_request').parameters.required_approving_review_count = 2;
  data.ruleset.rules.find(rule => rule.type === 'pull_request').parameters.required_review_thread_resolution = true;
  data.ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'Security audit', integration_id: 99 });
  data.environments.Production.can_admins_bypass = false;
  data.environments.Production.protection_rules.push({ type: 'wait_timer', wait_timer: 30 }, { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 88 } }] });
  const before = clone(data.environments.Production);
  const result = await verifyExisting(request);
  assert.equal(result.status, 'passed');
  assert.equal(result.environments.Production.waitMinutes, 30);
  assert.deepEqual(data.environments.Production, before);
  assert.equal(data.writes.length, 0);
});

test('verify-existing fails closed on an environment read error without treating 403 as absent or creating anything', async () => {
  const { data, request } = await configuredServer();
  const forbidden = async (method, path, body) => {
    if (path.includes('/environments?')) { const error = new Error('403 Forbidden'); error.code = 'GITHUB_READ_FAILED'; throw error; }
    return request(method, path, body);
  };
  await assert.rejects(verifyExisting(forbidden), error => error.code === 'GITHUB_READ_FAILED');
  assert.equal(data.writes.length, 0);
});
