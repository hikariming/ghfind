#!/usr/bin/env node
// Default mode performs GET requests only. --apply is an explicit administrator
// operation and requires a reviewed plan plus an exact current-state hash.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requiredJobs } from './feed-ci-evidence.mjs';

export const repository = 'hikariming/ghfind';
export const rulesetId = 18206694;
export const actionsIntegrationId = 15368;
export const owner = { login: 'hikariming', id: 23065064, type: 'User' };
export const environmentTargets = Object.freeze({ 'Feed staging': ['main', 'codex/feed-*'], 'Feed staging operations': ['main'], Production: ['main'] });
const base = `/repos/${repository}`;
const assert = (value, message, code = 'INVALID_PROTECTION_PLAN') => { if (!value) { const error = new Error(message); error.code = code; throw error; } };
const clone = value => JSON.parse(JSON.stringify(value));
export function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (left, right) => canonical(left) === canonical(right);
const environmentPath = name => `${base}/environments/${encodeURIComponent(name)}`;

function rulesetConfiguration(value) {
  assert(value.id === rulesetId && value.name === 'Protect main' && value.target === 'branch' && value.source === repository && value.source_type === 'Repository', 'Pinned Protect main ruleset identity mismatch');
  const result = Object.fromEntries(['name', 'target', 'enforcement', 'conditions', 'rules'].map(key => [key, clone(value[key])]));
  // A missing array means redacted, never an empty bypass list.
  if (Object.hasOwn(value, 'bypass_actors')) result.bypass_actors = clone(value.bypass_actors);
  return result;
}
function environmentConfiguration(value, policies) {
  if (value === null) return null;
  assert(Array.isArray(value.protection_rules) && typeof value.can_admins_bypass === 'boolean', 'Environment protection details are unreadable');
  const rules = value.protection_rules.map(rule => {
    if (rule.type === 'required_reviewers') return { type: rule.type, prevent_self_review: rule.prevent_self_review === true, reviewers: rule.reviewers.map(item => ({ type: item.type, id: item.reviewer.id })).sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id) };
    if (rule.type === 'wait_timer') return { type: rule.type, wait_timer: rule.wait_timer };
    if (rule.type === 'branch_policy') return { type: rule.type };
    // Preserve custom rules as read-only facts; never silently clear them.
    return clone(rule);
  }).sort((a, b) => a.type.localeCompare(b.type));
  return { name: value.name, can_admins_bypass: value.can_admins_bypass, protection_rules: rules, deployment_branch_policy: clone(value.deployment_branch_policy), branch_policies: policies.map(policy => ({ name: policy.name, type: policy.type ?? 'branch' })).sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)) };
}

export async function captureState(request = githubRequest) {
  const metadata = await request('GET', base);
  assert(metadata.full_name === repository && metadata.owner?.login === owner.login && metadata.owner?.type === 'User' && metadata.default_branch === 'main', 'Repository ownership/default branch drift');
  const account = await request('GET', `/users/${owner.login}`);
  assert(account.id === owner.id && account.login === owner.login && account.type === owner.type, 'Governance reviewer identity changed');
  const ruleset = await request('GET', `${base}/rulesets/${rulesetId}`);
  const listing = await request('GET', `${base}/environments?per_page=100`);
  assert(Array.isArray(listing.environments) && listing.total_count === listing.environments.length && listing.total_count <= 100, 'Complete environment inventory required; unreadable is not absent');
  const environments = {};
  for (const name of Object.keys(environmentTargets)) {
    const matches = listing.environments.filter(environment => environment.name.toLowerCase() === name.toLowerCase());
    assert(matches.length <= 1, `${name} environment identity is ambiguous`);
    if (!matches.length) { environments[name] = null; continue; }
    const value = await request('GET', environmentPath(name));
    let policies = [];
    if (value.deployment_branch_policy?.custom_branch_policies) {
      const list = await request('GET', `${environmentPath(name)}/deployment-branch-policies?per_page=100`);
      assert(Array.isArray(list.branch_policies) && list.total_count === list.branch_policies.length && list.total_count <= 100, `${name} branch policy inventory incomplete`);
      policies = list.branch_policies;
    }
    environments[name] = environmentConfiguration(value, policies);
  }
  return { format: 'ghfind-github-protection-state-v1', repository, administrator: metadata.permissions?.admin === true, ruleset: rulesetConfiguration(ruleset), environments };
}

export function validatePRChecks(workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')) {
  assert(/^  pull_request:\s*$/m.test(workflow), 'CI must run PR merge compatibility checks');
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  for (const [id, name] of Object.entries(requiredJobs)) {
    const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\\s\\S]))`, 'm').exec(jobs);
    assert(match && new RegExp(`^    name: ${name}$`, 'm').test(match[1]), `Required PR job ${id}/${name} absent`);
    assert(!/^    if:/m.test(match[1]) && !/^    continue-on-error:\s*true/m.test(match[1]), `${name} must report as a mandatory PR job`);
  }
  return Object.values(requiredJobs).map(context => ({ context, integration_id: actionsIntegrationId }));
}

export function buildPlan(state, workflow) {
  assert(state.format === 'ghfind-github-protection-state-v1' && state.repository === repository, 'Unexpected state format/repository');
  const checks = validatePRChecks(workflow);
  const currentHash = hash(state);
  const blockers = [];
  const notes = ['GitHub configuration changes are sequential, not an atomic multi-resource transaction. Serialize administrator changes; any failure stops and preserves completed tightening.', 'No secrets, bypass actors, existing reviewers, wait timers, custom rules or unrelated environments are removed.'];
  if (!state.administrator) blockers.push('ADMIN_REQUIRED: repository Administration write permission is required; PR bypass authorization is insufficient.');
  if (!Object.hasOwn(state.ruleset, 'bypass_actors')) blockers.push('ADMIN_REQUIRED: bypass_actors is redacted. An administrator must regenerate this plan; an omitted list is not an empty list.');
  const desiredRuleset = clone(state.ruleset);
  assert(desiredRuleset.enforcement === 'active', 'Protect main enforcement drift requires manual review');
  assert(desiredRuleset.conditions?.ref_name?.exclude?.length === 0 && (equal(desiredRuleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']) || equal(desiredRuleset.conditions.ref_name.include, ['refs/heads/main'])), 'Protect main branch scope drift requires manual review');
  const pullRequests = desiredRuleset.rules.filter(rule => rule.type === 'pull_request');
  assert(pullRequests.length === 1 && pullRequests[0].parameters.required_approving_review_count >= 1, 'Existing mandatory PR review rule absent or ambiguous');
  const methods = pullRequests[0].parameters.allowed_merge_methods;
  assert(Array.isArray(methods) && methods.some(method => method === 'merge' || method === 'rebase'), 'Existing merge methods require manual review');
  pullRequests[0].parameters.allowed_merge_methods = methods.filter(method => method !== 'squash');
  const statusRules = desiredRuleset.rules.filter(rule => rule.type === 'required_status_checks');
  assert(statusRules.length <= 1, 'Multiple status-check rules require manual review');
  let statusRule = statusRules[0];
  if (!statusRule) { statusRule = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: [] } }; desiredRuleset.rules.push(statusRule); }
  statusRule.parameters.strict_required_status_checks_policy = true;
  for (const check of checks) {
    const existing = statusRule.parameters.required_status_checks.filter(item => item.context === check.context);
    assert(existing.length <= 1, `Ambiguous required check ${check.context}`);
    if (!existing.length) statusRule.parameters.required_status_checks.push(check);
    else if (existing[0].integration_id === undefined || existing[0].integration_id === null) existing[0].integration_id = actionsIntegrationId;
    else assert(existing[0].integration_id === actionsIntegrationId, `${check.context} is bound to another integration; manual review required`);
  }
  const operations = [];
  if (!equal(desiredRuleset, state.ruleset)) operations.push({ kind: 'ruleset', method: 'PUT', path: `${base}/rulesets/${rulesetId}`, body: desiredRuleset, expected: desiredRuleset });
  for (const [name, branches] of Object.entries(environmentTargets)) {
    const current = state.environments[name];
    const path = environmentPath(name);
    const wantedPolicies = branches.map(branch => ({ name: branch, type: 'branch' })).sort((a, b) => a.name.localeCompare(b.name));
    if (current?.deployment_branch_policy?.protected_branches) { blockers.push(`PROTECTION_DRIFT: ${name} currently restricts protected branches; changing it could weaken that policy.`); continue; }
    if (current?.branch_policies.length && !equal(current.branch_policies, wantedPolicies)) { blockers.push(`PROTECTION_DRIFT: ${name} has a different nonempty branch policy. Preserve it and resolve the drift manually.`); continue; }
    const reviewersRule = current?.protection_rules.find(rule => rule.type === 'required_reviewers');
    const timerRule = current?.protection_rules.find(rule => rule.type === 'wait_timer');
    const reviewers = clone(reviewersRule?.reviewers ?? []);
    if (name === 'Feed staging operations') {
      if (reviewers.length && !reviewers.some(reviewer => reviewer.type === 'User' && reviewer.id === owner.id)) {
        // GitHub reviewer lists use OR semantics. Adding an approver to an
        // existing list would weaken the existing approval requirement.
        blockers.push(`PROTECTION_DRIFT: ${name} has other required reviewers; adding the owner would broaden its approval alternatives.`); continue;
      }
      if (!reviewers.length) reviewers.push({ type: 'User', id: owner.id });
    }
    if (name === 'Production' && (reviewers.length || timerRule?.wait_timer)) notes.push('Production has existing reviewer/timer protection. It is preserved; this script never adds a new pause to normal production deployment or clears an existing one.');
    const body = { wait_timer: timerRule?.wait_timer ?? 0, prevent_self_review: reviewersRule?.prevent_self_review ?? false, reviewers, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
    const matchesBody = current && equal(current.deployment_branch_policy, body.deployment_branch_policy) && equal(reviewersRule?.reviewers ?? [], body.reviewers) && (timerRule?.wait_timer ?? 0) === body.wait_timer && (reviewersRule?.prevent_self_review ?? false) === body.prevent_self_review;
    if (!matchesBody && current && (!current.can_admins_bypass || current.protection_rules.some(rule => !['required_reviewers', 'wait_timer', 'branch_policy'].includes(rule.type)))) { blockers.push(`PROTECTION_DRIFT: ${name} has admin-bypass/custom protection not writable through this API contract. Preserve it and configure restrictions in the administrator UI.`); continue; }
    if (!matchesBody) operations.push({ kind: 'environment', name, method: 'PUT', path, body, expected: { body, preserve: current ? { can_admins_bypass: current.can_admins_bypass, customRules: current.protection_rules.filter(rule => !['required_reviewers', 'wait_timer', 'branch_policy'].includes(rule.type)) } : null } });
    if (!current?.branch_policies.length) for (const policy of wantedPolicies) operations.push({ kind: 'branch-policy', name, method: 'POST', path: `${path}/deployment-branch-policies`, body: policy, expected: policy });
  }
  return { format: 'ghfind-github-protection-plan-v1', repository, rulesetId, currentHash, current: state, requiredPRChecks: checks, administratorRequired: true, readyToApply: blockers.length === 0, blockers, operations, notes };
}

function verifyOperation(operation, state) {
  if (operation.kind === 'ruleset') assert(equal(state.ruleset, operation.expected), 'Ruleset readback differs; stop without removing protection');
  else if (operation.kind === 'branch-policy') assert(state.environments[operation.name]?.branch_policies.some(policy => equal(policy, operation.expected)), `${operation.name} branch policy readback missing`);
  else {
    const actual = state.environments[operation.name], expected = operation.expected;
    assert(actual, `${operation.name} environment missing after PUT`);
    assert(equal(actual.deployment_branch_policy, expected.body.deployment_branch_policy), `${operation.name} deployment restriction readback mismatch`);
    const reviewers = actual.protection_rules.find(rule => rule.type === 'required_reviewers');
    const timer = actual.protection_rules.find(rule => rule.type === 'wait_timer');
    assert(equal(reviewers?.reviewers ?? [], expected.body.reviewers) && (reviewers?.prevent_self_review ?? false) === expected.body.prevent_self_review && (timer?.wait_timer ?? 0) === expected.body.wait_timer, `${operation.name} existing protections were not preserved`);
    if (expected.preserve) {
      assert(actual.can_admins_bypass === expected.preserve.can_admins_bypass, `${operation.name} admin bypass changed unexpectedly`);
      assert(equal(actual.protection_rules.filter(rule => !['required_reviewers', 'wait_timer', 'branch_policy'].includes(rule.type)), expected.preserve.customRules), `${operation.name} custom protection changed unexpectedly`);
    }
  }
}

function verifyTransition(before, after, operation) {
  const previous = clone(before), actual = clone(after);
  if (operation.kind === 'ruleset') { delete previous.ruleset; delete actual.ruleset; }
  else {
    if (operation.kind === 'branch-policy') {
      const wanted = clone(before.environments[operation.name]);
      wanted.branch_policies.push(clone(operation.body));
      wanted.branch_policies.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
      assert(equal(after.environments[operation.name], wanted), 'Branch-policy write changed other protections or policies');
    }
    delete previous.environments[operation.name]; delete actual.environments[operation.name];
  }
  assert(equal(previous, actual), 'Unrelated protection drift during operation; stop before further writes', 'STALE_PROTECTION_PLAN');
}

export async function applyPlan(plan, expectedCurrentHash, { request = githubRequest, workflow } = {}) {
  assert(/^[a-f0-9]{64}$/.test(expectedCurrentHash ?? ''), '--apply requires --expected-current-hash from a reviewed administrator plan');
  assert(plan.format === 'ghfind-github-protection-plan-v1' && plan.repository === repository && plan.rulesetId === rulesetId, 'Unexpected plan identity');
  assert(plan.currentHash === expectedCurrentHash, 'Expected hash does not match the reviewed plan');
  let state = await captureState(request);
  assert(hash(state) === expectedCurrentHash, 'Current state changed; regenerate and review the plan before any write', 'STALE_PROTECTION_PLAN');
  const rebuilt = buildPlan(state, workflow);
  assert(equal(rebuilt, plan), 'Plan differs from the pinned policy; arbitrary endpoint/body changes are forbidden');
  assert(rebuilt.readyToApply, rebuilt.blockers.join(' '), rebuilt.blockers.some(reason => reason.startsWith('ADMIN_REQUIRED')) ? 'ADMIN_REQUIRED' : 'PROTECTION_DRIFT');
  const completed = [];
  try {
    for (const operation of rebuilt.operations) {
      const fresh = await captureState(request);
      assert(equal(fresh, state), 'Protection drift before next operation; stop for a new review', 'STALE_PROTECTION_PLAN');
      await request(operation.method, operation.path, operation.body);
      const previous = state;
      state = await captureState(request);
      verifyTransition(previous, state, operation);
      verifyOperation(operation, state);
      completed.push({ kind: operation.kind, path: operation.path, readbackHash: hash(state) });
    }
    const remaining = buildPlan(state, workflow);
    assert(remaining.readyToApply && remaining.operations.length === 0, 'Final configuration does not satisfy every requested gate');
    return { format: 'ghfind-github-protection-result-v1', status: 'applied-and-verified', initialHash: expectedCurrentHash, finalHash: hash(state), completed, state };
  } catch (error) {
    error.completed = completed;
    error.message += ` Completed verified operations: ${completed.length}. No automatic rollback or protection removal was attempted. Read current state and regenerate the plan.`;
    throw error;
  }
}

export function githubRequest(method, path, body) {
  assert(path === `/users/${owner.login}` || path === base || path.startsWith(`${base}/`), 'GitHub target is outside the pinned repository');
  const args = ['api', '--method', method, path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body !== undefined) args.push('--input', '-');
  try { return Promise.resolve(JSON.parse(execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }))); }
  catch (cause) {
    let detail = ''; try { detail = JSON.parse(cause.stdout ?? '{}').message ?? ''; } catch { /* do not print arbitrary command output */ }
    const error = new Error(`${method} ${path} failed${detail ? `: ${detail}` : ''}. ${method === 'GET' ? 'Unreadable state is not absence.' : 'Administrator rights are required for this configuration operation.'}`);
    error.code = method === 'GET' ? 'GITHUB_READ_FAILED' : 'ADMIN_REQUIRED'; throw error;
  }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    assert(['--apply', '--plan', '--expected-current-hash', '--output'].includes(key) && !Object.hasOwn(options, key), 'Usage: feed-github-protection.mjs [--output plan.json] | --apply --plan plan.json --expected-current-hash <sha256> [--output result.json]');
    options[key] = key === '--apply' ? true : args[++index];
    assert(options[key] !== undefined && !String(options[key]).startsWith('--'), `Missing ${key} value`);
  }
  assert(options['--apply'] || (!options['--plan'] && !options['--expected-current-hash']), '--plan and --expected-current-hash are only accepted with --apply');
  assert(!options['--output'] || !existsSync(options['--output']), 'Output file already exists; choose a fresh path before any operation');
  const result = options['--apply'] ? await applyPlan(JSON.parse(readFileSync(options['--plan'], 'utf8')), options['--expected-current-hash']) : buildPlan(await captureState());
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options['--output']) writeFileSync(options['--output'], output, { mode: 0o600, flag: 'wx' });
  else process.stdout.write(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ code: error.code ?? 'PROTECTION_FAILURE', message: error.message, completed: error.completed ?? [] })); process.exitCode = 1; });
