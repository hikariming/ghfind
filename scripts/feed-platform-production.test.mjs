import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  template,
  validateManifest,
  renderRuntime,
  renderAdapter,
  validateReceipt,
  expectedBindings,
  validateReadiness,
  disableConsumers,
  verifyProductionToFile,
  readPreviousApplicationSnapshot,
} from "./feed-platform-production.mjs";
import {
  validateManifest as stagingValidate,
  template as stagingTemplate,
} from "./feed-platform-manifest.mjs";
import {
  verifyDeployment,
  limits,
  validatePreviousApplications,
} from "./feed-platform-production-readback.mjs";

const m = {
  ...template(),
  billing: {
    confirmed: true,
    evidence: "https://github.com/hikariming/ghfind/commit/" + "a".repeat(40),
    maximumMonthlyUSD: 100,
    projectedMonthlyUSD: 75,
  },
};
const sha = "a".repeat(40),
  image = `registry.cloudflare.com/${m.accountId}/ghfind-feed@sha256:${"b".repeat(64)}`;
const id = (n) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const admin = "r".repeat(32),
  token = "cf-metadata-only";
function fixture(mode = "off", options = {}) {
  let total = 0,
    readyCalls = 0,
    metadataCalls = 0,
    listCalls = 0;
  const instanceCalls = new Map();
  const workerId = id(1),
    adapterId = id(2),
    deployments = {};
  function active(worker) {
    const n = worker === m.runtimeWorker ? 1 : 2;
    return {
      deployments: [
        { id: id(n + 10), versions: [{ percentage: 100, version_id: id(n) }] },
      ],
    };
  }
  const ready = {
    ready: true,
    service: "feed-runtime",
    version: sha,
    contractVersion: "1",
    configuredImage: image,
    workerVersionId: workerId,
    mode,
    containers: ["api-0", "api-1", "executor-0"].map((target) => ({
      target,
      ready: true,
      version: sha,
      contractVersion: "1",
      storageWriterVersion: 2,
      storeProfile: "cf_d1_r2",
      writerEpoch: m.writerEpoch,
      mode,
      service: target === "executor-0" ? "feed-worker" : "feed-api",
      env: { SECRET: "must-not-upload" },
    })),
  };
  const fetcher = async (url, init) => {
    total++;
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    const u = new URL(url);
    if (u.origin === m.runtimeOrigin) {
      readyCalls++;
      assert.equal(u.pathname, "/readyz");
      assert.equal(init.headers.authorization, `Bearer ${admin}`);
      if (options.readyResponse) {
        const response = options.readyResponse(readyCalls);
        if (response) return response;
      }
      return Response.json(
        options.ready
          ? options.ready(structuredClone(ready), readyCalls, { metadataCalls })
          : ready,
      );
    }
    assert.equal(u.origin, "https://api.cloudflare.com");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    const path = u.pathname.split(`/accounts/${m.accountId}`)[1];
    if (path === "/queues" || path.startsWith("/queues/")) {
      const names = [m.queue, m.deadLetterQueue, m.terminalParkingQueue];
      const ids = names.map((_, i) => String(i + 1).repeat(32));
      const index =
        path === "/queues"
          ? names.indexOf(u.searchParams.get("name"))
          : ids.indexOf(path.split("/")[2]);
      assert.ok(index >= 0, `unexpected queue lookup: ${u}`);
      const name = names[index],
        queue_id = ids[index];
      const consumer = {
        consumer_id: String(index + 4).repeat(32),
        queue_name: name,
        type: "worker",
        script_name: m.runtimeWorker,
        dead_letter_queue: names[index + 1],
        settings: {
          batch_size: 1,
          max_concurrency: 1,
          max_retries: 5,
          max_wait_time_ms: 5000,
        },
        ignoredSecret: "must-not-upload",
      };
      const consumers = mode === "baseline" && index < 2 ? [consumer] : [];
      let result =
        path === "/queues"
          ? [{ queue_name: name, queue_id }]
          : path.endsWith("/consumers")
            ? consumers
            : {
                queue_name: name,
                queue_id,
                consumers,
                consumers_total_count: consumers.length,
                settings: {
                  message_retention_period: index < 2 ? 345600 : 1209600,
                  delivery_delay: 0,
                  delivery_paused: false,
                },
                ignoredSecret: "must-not-upload",
              };
      if (options.queue)
        result = options.queue(path, structuredClone(result), name);
      return Response.json({ success: true, result });
    }
    const match =
      /^\/workers\/scripts\/(ghfind-feed-(?:runtime|adapter)-production)\/(deployments|versions\/[^/]+|subdomain|schedules)$/.exec(
        path,
      );
    assert.ok(match, path);
    const [_, worker, op] = match;
    const role = worker === m.runtimeWorker ? "runtime" : "adapter";
    let result;
    if (op === "deployments") {
      deployments[worker] = (deployments[worker] ?? 0) + 1;
      result = active(worker);
      if (options.changedWorker === worker && deployments[worker] > 1)
        result.deployments[0].versions[0].version_id = id(999);
    } else if (op === "subdomain")
      result = { enabled: role === "runtime", previews_enabled: false };
    else if (op === "schedules")
      result = {
        schedules:
          mode === "baseline"
            ? [{ cron: "* * * * *", ignoredSecret: "must-not-upload" }]
            : [],
      };
    else
      result = {
        id: role === "runtime" ? workerId : adapterId,
        annotations: { "workers/tag": `production-${sha}` },
        resources: {
          bindings: expectedBindings(m, sha, image, mode, role).map((b) =>
            b.type === "durable_object_namespace"
              ? { ...b, namespace_id: id(b.class_name === "FeedAPI" ? 31 : 32) }
              : b,
          ),
          script: { etag: `script-${role}` },
          script_runtime: {
            compatibility_date: "2026-09-08",
            compatibility_flags: ["nodejs_compat"],
          },
        },
      };
    if (options.platform)
      result = options.platform(path, structuredClone(result));
    return Response.json({ success: true, result });
  };
  const applications = ["feedapi", "feedexecutor"].map((suffix, i) => ({
    id: id(i + 3),
    name: `${m.runtimeWorker}-${suffix}`,
    image,
    state: "active",
    instances: i === 0 ? 2 : 1,
    version: 7,
    env: { SECRET: "must-not-upload" },
  }));
  const metadata = async (args, { signal }) => {
    metadataCalls++;
    assert.ok(signal instanceof AbortSignal);
    if (options.delay && metadataCalls === 1)
      await sleep(options.delay, undefined, { signal });
    if (args[1] === "list") {
      listCalls++;
      return options.applications
        ? options.applications(structuredClone(applications), listCalls)
        : applications;
    }
    if (args[1] === "info") {
      const a = applications.find((a) => a.id === args[2]);
      const result = {
        id: a.id,
        name: a.name,
        max_instances: a.name.endsWith("feedapi") ? 2 : 1,
        durable_objects: {
          namespace_id: id(a.name.endsWith("feedapi") ? 31 : 32),
        },
        configuration: {
          image,
          instance_type: "basic",
          env: { SECRET: "must-not-upload" },
        },
      };
      return options.appInfo ? options.appInfo(result) : result;
    }
    assert.deepEqual(args.slice(0, 2), ["containers", "instances"]);
    assert.deepEqual(args.slice(3), ["--per-page", "10", "--json"]);
    const names = args[2] === id(3) ? ["api-0", "api-1"] : ["executor-0"];
    const result = {
      instances: names.map((name) => ({
        id: `instance-${name}`,
        name,
        state: "running",
        version: 7,
        env: { SECRET: "must-not-upload" },
        arbitraryBody: { identity: "private" },
      })),
      result_info: {},
    };
    const attempt = (instanceCalls.get(args[2]) ?? 0) + 1;
    instanceCalls.set(args[2], attempt);
    return options.instances
      ? options.instances(result, { appId: args[2], attempt, signal })
      : result;
  };
  return {
    fetcher,
    metadata,
    options: {
      secret: admin,
      token,
      fetcher,
      metadata,
      ...(options.bounds ? { limits: options.bounds } : {}),
      ...(Object.hasOwn(options, "previousApplications")
        ? { previousApplications: options.previousApplications }
        : {}),
    },
    count: () => ({
      total,
      readyCalls,
      metadataCalls,
      instanceCalls: [...instanceCalls.values()].reduce((a, b) => a + b, 0),
    }),
    ready,
  };
}

function previousApps(previousImage = image.replace(/b{64}$/, "c".repeat(64))) {
  return ["feedapi", "feedexecutor"].map((suffix, index) => ({
    id: id(index + 3),
    name: `${m.runtimeWorker}-${suffix}`,
    version: 6,
    image: previousImage,
    state: "ready",
    arbitrarySecret: "never-upload-snapshot",
  }));
}
test("predeployment snapshot permits only the exact prior digest/version until the expected app converges", async () => {
  const previous = previousApps();
  let appsRead = 0;
  const f = fixture("off", {
    previousApplications: previous,
    bounds: { applicationIntervalMs: 1 },
    applications: (apps, call) => {
      appsRead = call;
      return apps.map((app, i) =>
        call < i + 2 ? { ...app, ...previous[i] } : app,
      );
    },
    ready: (r) => {
      assert.ok(
        appsRead >= 3,
        "never wake an old-image process while app metadata is pending",
      );
      return r;
    },
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.status, "passed");
  assert.equal(
    r.applicationObservations.filter(
      (o) => o.reason === "prior_application_pending",
    ).length,
    2,
  );
  assert.ok(
    r.applications.every(
      (a) =>
        a.image === image &&
        a.version === 7 &&
        a.instances.every((i) => i.state === "running" && i.version === 7),
    ),
  );
  assert.equal(JSON.stringify(r).includes("never-upload-snapshot"), false);
  assert.deepEqual(
    r.previousApplications,
    previous.map(({ id, name, version, image }) => ({
      id,
      name,
      version,
      image,
    })),
  );
  const strict = fixture("off", { applications: () => previous });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", strict.options),
    /application_image_changed/,
  );
  assert.equal(strict.count().metadataCalls, 1);
});
test("target-image provisioning may reach initial process readiness before application health converges", async () => {
  let readyObserved = false;
  const f = fixture("off", {
    previousApplications: previousApps(),
    bounds: { applicationIntervalMs: 1 },
    ready: (r) => {
      readyObserved = true;
      return r;
    },
    applications: (apps) =>
      apps.map((app) => ({
        ...app,
        state: readyObserved ? "active" : "provisioning",
      })),
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.status, "passed");
  assert.equal(
    r.applicationObservations.filter(
      (o) => o.phase === "identity" && o.reason === "application_provisioning",
    ).length,
    2,
  );
  assert.equal(
    r.applicationObservations.filter(
      (o) => o.phase === "convergence" && o.status === "converged",
    ).length,
    2,
  );
  assert.ok(
    r.applications.every((app) =>
      app.instances.every((i) => i.state === "running"),
    ),
  );
});
test("first-install missing targets grant no old-image permission and unrelated applications are ignored", async () => {
  for (const snapshot of [
    [],
    [
      {
        name: "unrelated-application",
        id: "unparsed",
        image: "private-registry",
        version: null,
      },
    ],
    previousApps().slice(1),
  ]) {
    const f = fixture("off", { previousApplications: snapshot });
    assert.equal(
      (await verifyDeployment(m, sha, image, "off", f.options)).status,
      "passed",
    );
  }
  const f = fixture("off", {
    previousApplications: [],
    applications: () => previousApps(),
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    /application_image_changed/,
  );
});
test("malformed snapshots reject before any network read and bounded snapshot files remain parseable", async () => {
  const previous = previousApps();
  for (const snapshot of [
    null,
    {},
    [...previous, previous[0]],
    [previous[0], { ...previous[1], id: previous[0].id }],
    ...[
      { id: "bad" },
      { version: null },
      { image: "https://not-a-pinned-registry/image" },
      { image: image.replace(m.accountId, "e".repeat(32)) },
    ].map((patch) => [{ ...previous[0], ...patch }, previous[1]]),
  ]) {
    const f = fixture("off", { previousApplications: snapshot });
    await assert.rejects(verifyDeployment(m, sha, image, "off", f.options));
    assert.equal(f.count().total, 0);
  }
  const dir = mkdtempSync(join(tmpdir(), "feed-app-snapshot-"));
  try {
    const file = join(dir, "applications.json");
    writeFileSync(file, JSON.stringify(previous));
    assert.equal(
      validatePreviousApplications(readPreviousApplicationSnapshot(file), m)
        .size,
      2,
    );
    writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
    assert.throws(() => readPreviousApplicationSnapshot(file), /exceeds bound/);
    writeFileSync(file, "not json");
    assert.throws(() => readPreviousApplicationSnapshot(file));
    assert.throws(() => readPreviousApplicationSnapshot(dir), /not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("snapshot never permits a third digest, wrong UUID/version, unhealthy prior or stale version with the new image", async () => {
  const previous = previousApps();
  for (const patch of [
    { image: image.replace(/b{64}$/, "d".repeat(64)) },
    { id: id(999) },
    { version: 5 },
    { version: 7 },
    { state: "degraded" },
    { state: "unknown" },
    { image, version: 6 },
    { image, version: 5 },
    { image, version: "5" },
    { image, version: "06" },
  ]) {
    const f = fixture("off", {
      previousApplications: previous,
      applications: (apps) => [
        { ...apps[0], ...previous[0], ...patch },
        apps[1],
      ],
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /immutable application/,
    );
    assert.equal(f.count().metadataCalls, 1);
    assert.equal(f.count().instanceCalls, 0);
  }
});
test("expected-image entry pins version across both application retry streams and final readback", async () => {
  const previous = previousApps();
  for (const patch of [
    previous[1],
    { ...previous[1], image, version: 8 },
    { ...previous[1], image, version: 7, id: id(999) },
  ]) {
    const f = fixture("off", {
      previousApplications: previous,
      bounds: { applicationIntervalMs: 1 },
      applications: (apps, call) => [
        call < 3 ? { ...apps[0], ...previous[0] } : apps[0],
        call < 2 ? apps[1] : patch,
      ],
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /immutable application/,
    );
    assert.equal(
      f.count().metadataCalls,
      2,
      "a second app cannot regress unseen while the first app waits",
    );
  }
  const final = fixture("off", {
    previousApplications: previous,
    applications: (apps, call) => (call === 1 ? apps : previous),
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", final.options),
    /immutable application/,
  );
});
test("prior application waiting shares the original attempts and deadline without accepting an old digest", async () => {
  for (const bound of [
    { applicationAttempts: 3, applicationIntervalMs: 1 },
    { applicationConvergenceMs: 20, applicationIntervalMs: 100 },
  ]) {
    const previous = previousApps();
    const f = fixture("off", {
      previousApplications: previous,
      bounds: bound,
      applications: () => previous,
    });
    const started = performance.now();
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      (error) => {
        assert.ok(
          error.readbackFailure.applicationObservations.every(
            (o) => o.reason === "prior_application_pending",
          ),
        );
        assert.throws(() =>
          renderRuntime(m, image, sha, "baseline", error.readbackFailure),
        );
        return true;
      },
    );
    assert.ok(performance.now() - started < 500);
    assert.equal(f.count().instanceCalls, 0);
  }
});
test("same-image baseline can retain the application version but cannot retain off-mode process readiness", async () => {
  const previous = previousApps(image).map((app) => ({ ...app, version: 7 }));
  const f = fixture("baseline", { previousApplications: previous });
  assert.equal(
    (await verifyDeployment(m, sha, image, "baseline", f.options)).status,
    "passed",
  );
  const old = fixture("baseline", {
    previousApplications: previous,
    ready: (r) => ({
      ...r,
      containers: r.containers.map((i) => ({ ...i, mode: "off" })),
    }),
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "baseline", old.options),
    /container readiness differs/,
  );
  assert.equal(old.count().readyCalls, 1);
});
test("prior-image and instance maximum attempts still fit 52 metadata reads without resetting application budgets", async () => {
  const previous = previousApps();
  const f = fixture("off", {
    previousApplications: previous,
    bounds: { applicationIntervalMs: 1, instanceIntervalMs: 1 },
    applications: (apps, call) =>
      apps.map((app, i) =>
        call < (i === 0 ? 8 : 15) ? { ...app, ...previous[i] } : app,
      ),
    instances: (r, { attempt }) =>
      attempt < 8
        ? {
            ...r,
            instances: r.instances.map((i) => ({
              ...i,
              state: "provisioning",
            })),
          }
        : r,
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.keepWarm.metadataReads, 52);
  assert.equal(r.applicationObservations.length, 18);
  assert.equal(r.instanceObservations.length, 16);
  assert.equal(r.keepWarm.readinessRequests, 18);
  assert.ok(
    r.applicationObservations
      .filter((o) => o.phase !== "final")
      .every((o) => o.attempt <= 8),
  );
});
test("initial protected dependency failures retry only after both Worker identities are verified", async () => {
  const f = fixture("off", {
    bounds: { initialReadinessIntervalMs: 1 },
    readyResponse: (call) =>
      call < 3
        ? Response.json(
            {
              error: "container_dependency_not_ready",
              private: "never-upload-error",
            },
            { status: 503 },
          )
        : null,
  });
  const checked = new Set();
  f.options.fetcher = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes("/versions/"))
      checked.add(u.pathname.split("/scripts/")[1].split("/")[0]);
    if (u.origin === m.runtimeOrigin)
      assert.deepEqual(
        [...checked].sort(),
        [m.runtimeWorker, m.adapterWorker].sort(),
      );
    return f.fetcher(url, init);
  };
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.deepEqual(
    r.readinessObservations
      .filter((o) => o.phase === "initial")
      .map(({ attempt, status, errorCode }) => ({
        attempt,
        status,
        errorCode,
      })),
    [
      { attempt: 1, status: 503, errorCode: "container_dependency_not_ready" },
      { attempt: 2, status: 503, errorCode: "container_dependency_not_ready" },
      { attempt: 3, status: 200, errorCode: null },
    ],
  );
  assert.equal(JSON.stringify(r).includes("never-upload-error"), false);
  assert.equal(r.keepWarm.readinessRequests, 6);
});
test("nondependency HTTP failures and malformed error responses preserve safe diagnostics without retry", async () => {
  for (const makeResponse of [
    () =>
      Response.json(
        { error: "container_dependency_not_ready" },
        { status: 401 },
      ),
    () => Response.json({ error: "unauthorized" }, { status: 403 }),
    () =>
      Response.json(
        { error: "container_version_or_contract_mismatch" },
        { status: 503 },
      ),
    () => Response.json({ error: "container_not_ready" }, { status: 503 }),
    () => Response.json({ error: "feed_unavailable" }, { status: 503 }),
    () => Response.json({ error: "SECRET-must-not-upload" }, { status: 503 }),
    () =>
      new Response("<html>SECRET-must-not-upload</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response('{"error":"container_dependency_not_ready"}', {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response("not-json", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    () =>
      Response.json(
        { error: "container_dependency_not_ready", padding: "x".repeat(17000) },
        { status: 503 },
      ),
  ]) {
    const f = fixture("off", { readyResponse: makeResponse });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      (error) => {
        const r = error.readbackFailure;
        assert.equal(r.stage, "initial_readiness");
        assert.equal(r.readinessObservations.length, 1);
        assert.ok(r.readinessObservations[0].status >= 400);
        assert.equal(
          JSON.stringify(r).includes("SECRET-must-not-upload"),
          false,
        );
        assert.equal(r.lastValidatedReadiness, null);
        return true;
      },
    );
    assert.equal(f.count().readyCalls, 1);
    assert.equal(f.count().metadataCalls, 0);
  }
});
test("initial dependency retry exhaustion, request body deadline and global quotas all remain finite", async () => {
  assert.equal(limits.durationMs, 180000);
  assert.equal(limits.readinessRequests, 95);
  assert.equal(limits.initialReadinessAttempts, 8);
  assert.equal(limits.initialReadinessConvergenceMs, 60000);
  for (const bounds of [
    { initialReadinessAttempts: 3, initialReadinessIntervalMs: 1 },
    { initialReadinessConvergenceMs: 20, initialReadinessIntervalMs: 100 },
    { readinessRequests: 2, initialReadinessIntervalMs: 1 },
    { durationMs: 20, initialReadinessIntervalMs: 100 },
  ]) {
    const f = fixture("off", {
      bounds,
      readyResponse: () =>
        Response.json(
          { error: "container_dependency_not_ready" },
          { status: 503 },
        ),
    });
    const at = performance.now();
    await assert.rejects(verifyDeployment(m, sha, image, "off", f.options));
    assert.ok(performance.now() - at < 500);
    assert.ok(f.count().readyCalls <= 3);
    assert.equal(f.count().metadataCalls, 0);
  }
  const slow = fixture("off", {
    bounds: { requestMs: 20 },
    readyResponse: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
  });
  const at = performance.now();
  await assert.rejects(verifyDeployment(m, sha, image, "off", slow.options));
  assert.ok(performance.now() - at < 500);
  assert.equal(slow.count().readyCalls, 1);
});
test("dependency code after initial success cannot hide a heartbeat failure", async () => {
  const f = fixture("off", {
    delay: 1000,
    bounds: { intervalMs: 5 },
    readyResponse: (call) =>
      call > 1
        ? Response.json(
            { error: "container_dependency_not_ready" },
            { status: 503 },
          )
        : null,
  });
  const at = performance.now();
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    (error) => {
      assert.equal(
        error.readbackFailure.readinessObservations.at(-1).phase,
        "heartbeat",
      );
      assert.equal(
        error.readbackFailure.readinessObservations.at(-1).errorCode,
        "container_dependency_not_ready",
      );
      return true;
    },
  );
  assert.ok(performance.now() - at < 500);
  assert.equal(f.count().readyCalls, 2);
});

test("production manifest is independently pinned and staging refuses production/dev IDs", () => {
  assert.equal(validateManifest(m), m);
  assert.throws(() => validateManifest(template()), /budget/);
  for (const altered of [
    { ...m, environment: "staging" },
    { ...m, runtimeOrigin: "https://evil.invalid" },
    {
      ...m,
      feedDatabase: {
        ...m.feedDatabase,
        id: "bd305af9-2cab-4fe8-8c2f-324391cf105e",
      },
    },
    { ...m, coreDatabase: m.feedDatabase },
    { ...m, sql: "SELECT 1" },
    { ...m, writerEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...m, billing: { ...m.billing, projectedMonthlyUSD: 81 } },
  ])
    assert.throws(() => validateManifest(altered));
  for (const forbidden of [
    m.coreDatabase.id,
    m.feedDatabase.id,
    "bd305af9-2cab-4fe8-8c2f-324391cf105e",
  ]) {
    const staging = {
      ...stagingTemplate(),
      coreDatabase: { name: "ghfind-feed-staging-core", id: forbidden },
    };
    assert.throws(() => stagingValidate(staging), /unsafe coreDatabase/);
  }
  assert.throws(
    () => renderRuntime(m, image.replace(/@sha256:.+/, ":latest"), sha, "off"),
    /immutable/,
  );
});
test("bootstrap off has no asynchronous entrypoints; production resources and capacity are fixed", () => {
  const c = renderRuntime(m, image, sha, "off"),
    a = renderAdapter(m, sha);
  assert.equal(c.vars.FEED_MODE, "off");
  assert.equal(c.vars.FEED_SOURCE_RELAY_ENABLED, "false");
  assert.equal(c.vars.FEED_EXECUTOR_ENABLED, "true");
  assert.deepEqual(c.triggers, { crons: [] });
  assert.equal(c.queues.consumers, undefined);
  assert.deepEqual(
    c.containers.map((c) => [c.instance_type, c.max_instances, c.image]),
    [
      ["basic", 2, image],
      ["basic", 1, image],
    ],
  );
  assert.deepEqual(
    a.d1_databases.map((d) => d.database_id),
    [m.feedDatabase.id, m.coreDatabase.id],
  );
  assert.equal(a.workers_dev, false);
  assert.equal(a.preview_urls, false);
  assert.equal(a.vars.FEED_SEMANTIC_STATE, "disabled");
  assert.equal(a.main, "../feed/src/index.ts");
  assert.equal(a.vars.FEED_RELEASE_SHA, sha);
  assert.equal(c.secrets.required.includes("FEED_OPERATOR_SECRET"), false);
  assert.throws(
    () => renderRuntime(m, image, sha, "baseline"),
    /readiness receipt/,
  );
});
test("actual readback whitelists all published identity fields and gates baseline", async () => {
  const f = fixture();
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.keepWarm.metadataReads, 24);
  assert.equal(r.keepWarm.stopped, true);
  assert.equal(r.status, "passed");
  assert.equal(JSON.stringify(r).includes("must-not-upload"), false);
  assert.equal(JSON.stringify(r).includes("arbitraryBody"), false);
  const c = renderRuntime(m, image, sha, "baseline", r);
  assert.equal(c.vars.FEED_MODE, "baseline");
  assert.equal(c.vars.FEED_SOURCE_RELAY_ENABLED, "true");
  assert.equal(c.queues.consumers.length, 2);
  assert.deepEqual(c.triggers.crons, ["* * * * *"]);
  assert.equal(c.queues.consumers[1].dead_letter_queue, m.terminalParkingQueue);
  assert.equal(
    c.queues.consumers.some((q) => q.queue === m.terminalParkingQueue),
    false,
  );
  assert.throws(
    () => validateReceipt(r, m, sha, image, "baseline"),
    /matching/,
  );
  assert.throws(
    () =>
      validateReceipt(
        r,
        m,
        sha,
        image,
        "off",
        Date.parse(r.observedAt) + 900001,
      ),
    /expired/,
  );
  assert.throws(
    () => renderRuntime({ ...m, writerEpoch: 2 }, image, sha, "baseline", r),
    /matching/,
  );
  assert.throws(
    () => renderRuntime(m, image, "c".repeat(40), "baseline", r),
    /matching/,
  );
  assert.throws(
    () =>
      renderRuntime(m, image, sha, "baseline", {
        ...r,
        readiness: r.readiness.slice(1),
      }),
    /missing/,
  );
  assert.throws(
    () => renderRuntime(m, image, sha, "baseline", { ...r, applications: [] }),
    /missing/,
  );
});
test("Wrangler ready application summary still requires all named running instances and readiness", async () => {
  // Match the observed first production list: API active/2, executor ready/1.
  // Also cover ready for both applications: app.instances is an independent count.
  for (const states of [
    ["active", "ready"],
    ["ready", "ready"],
  ]) {
    const f = fixture("off", {
      applications: (apps) =>
        apps.map((app, i) => ({ ...app, state: states[i] })),
    });
    const r = await verifyDeployment(m, sha, image, "off", f.options);
    assert.equal(r.status, "passed");
    assert.equal(r.keepWarm.metadataReads, 24);
    assert.deepEqual(
      r.applications.map((a) =>
        a.instances.map((i) => [i.name, i.state, i.version]),
      ),
      [
        [
          ["api-0", "running", 7],
          ["api-1", "running", 7],
        ],
        [["executor-0", "running", 7]],
      ],
    );
    assert.equal(r.readiness.length, 3);
    assert.ok(f.count().readyCalls >= 2);
  }
});
test("unhealthy or invalid application summaries fail despite healthy named instances", async () => {
  for (const state of [
    "degraded",
    "unknown",
    "running",
    "inactive",
    null,
    undefined,
  ]) {
    const f = fixture("off", {
      applications: (apps) => apps.map((app) => ({ ...app, state })),
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /application identity or health summary/,
    );
  }
});
test("only correctly identified provisioning applications can converge before strict instance checks", async () => {
  const f = fixture("off", {
    bounds: { applicationIntervalMs: 1 },
    applications: (apps, call) =>
      apps.map((app, i) => ({
        ...app,
        state: call < (i === 0 ? 3 : 4) ? "provisioning" : "active",
      })),
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.status, "passed");
  assert.equal(r.keepWarm.metadataReads, 27);
  assert.deepEqual(
    r.applicationObservations.map((o) => o.status),
    [
      "pending",
      "pending",
      "converged",
      "pending",
      "converged",
      "converged",
      "converged",
    ],
  );
  assert.equal(
    r.applicationObservations[0].observedAt,
    r.applicationObservations[3].observedAt,
  );
  assert.equal(
    r.applicationObservations[0].applications[0].imageDigest,
    "b".repeat(64),
  );
  assert.deepEqual(
    r.applicationObservations.slice(-2).map((o) => o.phase),
    ["final", "final"],
  );
  assert.ok(
    r.applications.every((a) =>
      a.instances.every((i) => i.state === "running" && i.version === 7),
    ),
  );
  assert.equal(JSON.stringify(r).includes("must-not-upload"), false);
});
test("permanent provisioning persists bounded application observations without approving baseline", async () => {
  const f = fixture("off", {
    bounds: { applicationAttempts: 3, applicationIntervalMs: 1 },
    applications: (apps) =>
      apps.map((app) => ({ ...app, state: "provisioning" })),
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    (error) => {
      assert.match(error.message, /summary convergence attempts exhausted/);
      const r = error.readbackFailure;
      assert.equal(r.status, "failed");
      assert.equal(r.stage, "application_convergence");
      assert.equal(r.applicationObservations.length, 3);
      assert.ok(
        r.applicationObservations.every(
          (o) => o.reason === "application_provisioning",
        ),
      );
      assert.equal(JSON.stringify(r).includes("must-not-upload"), false);
      assert.throws(
        () => renderRuntime(m, image, sha, "baseline", r),
        /matching/,
      );
      return true;
    },
  );
  assert.equal(f.count().metadataCalls, 3);
  assert.equal(f.count().instanceCalls, 0);
});
test("provisioning cannot conceal changed identity, digest or version and malformed health never retries", async () => {
  for (const patch of [
    { id: id(900) },
    { version: 8 },
    { image: image.replace(/b{64}$/, "c".repeat(64)) },
    { state: "degraded" },
    { state: "unknown" },
    { state: null },
    { version: null },
  ]) {
    const f = fixture("off", {
      bounds: { applicationIntervalMs: 1 },
      applications: (apps, call) =>
        apps.map((app) => ({
          ...app,
          state: "provisioning",
          ...(call > 1 ? patch : {}),
        })),
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      (error) => {
        assert.match(
          error.message,
          /application identity or health summary differs/,
        );
        assert.equal(error.readbackFailure.applicationObservations.length, 2);
        assert.equal(
          error.readbackFailure.applicationObservations[1].status,
          "rejected",
        );
        return true;
      },
    );
    assert.equal(f.count().metadataCalls, 2);
    assert.equal(f.count().instanceCalls, 0);
  }
  for (const applications of [
    () => null,
    () => [null],
    () => [],
    (apps) => [...apps, apps[0]],
  ]) {
    const f = fixture("off", { applications });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      (error) => {
        assert.equal(
          error.readbackFailure.applicationObservations[0].reason,
          "application_population_invalid",
        );
        return true;
      },
    );
    assert.equal(f.count().metadataCalls, 1);
  }
});
test("application convergence deadline and heartbeat failure stop all summary retries", async () => {
  for (const failure of ["deadline", "heartbeat"]) {
    const f = fixture("off", {
      bounds: {
        applicationConvergenceMs: 30,
        applicationIntervalMs: 100,
        ...(failure === "heartbeat" ? { intervalMs: 5 } : {}),
      },
      applications: (apps) =>
        apps.map((app) => ({ ...app, state: "provisioning" })),
      ready: (r, call) => {
        if (failure === "heartbeat" && call > 1)
          r.containers[0].mode = "baseline";
        return r;
      },
    });
    const start = performance.now();
    await assert.rejects(verifyDeployment(m, sha, image, "off", f.options));
    assert.ok(performance.now() - start < 500);
    assert.equal(f.count().metadataCalls, 1);
    const before = f.count().total;
    await sleep(20);
    assert.equal(f.count().total, before);
  }
});
test("the first shared application metadata request is included in the convergence deadline", async () => {
  const f = fixture("off", {
    delay: 1000,
    bounds: { applicationConvergenceMs: 30 },
  });
  const started = performance.now();
  await assert.rejects(verifyDeployment(m, sha, image, "off", f.options));
  assert.ok(performance.now() - started < 500);
  assert.equal(f.count().metadataCalls, 1);
  assert.equal(f.count().instanceCalls, 0);
});
test("maximal application and instance convergence stays within fixed 180s and 52 metadata quotas", async () => {
  const f = fixture("off", {
    bounds: { applicationIntervalMs: 1, instanceIntervalMs: 1 },
    applications: (apps, call) =>
      apps.map((app, i) => ({
        ...app,
        state: call < (i === 0 ? 8 : 15) ? "provisioning" : "ready",
      })),
    instances: (r, { attempt }) =>
      attempt < 8
        ? {
            ...r,
            instances: r.instances.map((i) => ({
              ...i,
              state: "provisioning",
            })),
          }
        : r,
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(limits.durationMs, 180000);
  assert.equal(limits.readinessRequests, 95);
  assert.equal(limits.applicationAttempts, 8);
  assert.equal(limits.applicationConvergenceMs, 60000);
  assert.equal(r.applicationObservations.length, 18);
  assert.equal(r.instanceObservations.length, 16);
  assert.equal(r.keepWarm.metadataReads, 52);
  assert.equal(r.keepWarm.readinessRequests, 18);
});
test("ready application summary cannot hide immutable application identity drift", async () => {
  for (const transform of [
    (apps) => [
      { ...apps[0], image: image.replace(/b{64}$/, "c".repeat(64)) },
      apps[1],
    ],
    (apps) => [{ ...apps[0], id: "unknown" }, apps[1]],
    (apps) => [{ ...apps[0], version: null }, apps[1]],
    (apps) => [{ ...apps[0], name: "foreign-feedapi" }, apps[1]],
    (apps) => [...apps, apps[0]],
  ]) {
    const f = fixture("off", {
      applications: (apps) =>
        transform(apps.map((app) => ({ ...app, state: "ready" }))),
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /application identity or health summary/,
    );
  }
});
test("ready application summary cannot replace running instance, version or population proof", async () => {
  const changes = [
    // Wrangler uses running, not active; inactive/null is a registered DO without a running instance.
    ...[
      "active",
      "inactive",
      "provisioning",
      "failed",
      "stopping",
      "stopped",
      "unhealthy",
      "unknown",
    ].map((state) => (result) => ({
      ...result,
      instances: result.instances.map((i) => ({
        ...i,
        state,
        ...(state === "inactive" ? { version: null } : {}),
      })),
    })),
    (result) => ({
      ...result,
      instances: result.instances.map((i) => ({ ...i, version: 6 })),
    }),
    (result) => ({
      ...result,
      instances: result.instances.map((i) => ({ ...i, name: "foreign" })),
    }),
    (result) => ({
      ...result,
      instances: result.instances.map((i) => ({ ...i, id: null })),
    }),
    (result) => ({ ...result, instances: result.instances.slice(1) }),
    (result) => ({
      ...result,
      instances: result.instances.map(() => result.instances[0]),
    }),
    (result) => ({
      ...result,
      result_info: { next_page_token: "another-page" },
    }),
  ];
  for (const instances of changes) {
    const f = fixture("off", {
      applications: (apps) => apps.map((app) => ({ ...app, state: "ready" })),
      instances,
      bounds: { instanceAttempts: 2, instanceIntervalMs: 1 },
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /instance version\/state differs|unexpected instance population/,
    );
  }
});
test("ready summary and matching instances cannot hide a final process readiness change", async () => {
  const f = fixture("baseline", {
    applications: (apps) => apps.map((app) => ({ ...app, state: "ready" })),
    ready: (r, _call, { metadataCalls }) => {
      if (metadataCalls === 6) r.containers[2].mode = "off";
      return r;
    },
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "baseline", f.options),
    /container readiness differs/,
  );
  assert.equal(f.count().metadataCalls, 6);
});
test("bounded placement convergence preserves each actual snapshot and requires fresh process readiness", async () => {
  const f = fixture("off", {
    bounds: { instanceIntervalMs: 1 },
    instances: (result, { appId, attempt }) => {
      if (appId === id(3) && attempt < 4) {
        const patch = [
          { state: "inactive", version: null },
          { state: "stopped", version: 6 },
          { state: "running", version: 6 },
        ][attempt - 1];
        Object.assign(result.instances[1], patch);
      }
      return result;
    },
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.status, "passed");
  assert.equal(r.keepWarm.metadataReads, 27);
  assert.equal(f.count().instanceCalls, 5);
  assert.ok(f.count().readyCalls >= 7);
  assert.deepEqual(
    r.instanceObservations.map((o) => o.status),
    ["pending", "pending", "pending", "converged", "converged"],
  );
  assert.deepEqual(
    r.instanceObservations
      .slice(0, 4)
      .map((o) => [o.instances[1].state, o.instances[1].version]),
    [
      ["inactive", null],
      ["stopped", 6],
      ["running", 6],
      ["running", 7],
    ],
  );
  for (const o of r.instanceObservations) {
    assert.equal(o.applicationVersion, 7);
    assert.ok(Date.parse(o.readinessObservedAt) <= Date.parse(o.observedAt));
    assert.deepEqual(Object.keys(o.instances[0]), [
      "id",
      "name",
      "state",
      "version",
    ]);
  }
  assert.equal(JSON.stringify(r).includes("must-not-upload"), false);
  assert.equal(JSON.stringify(r).includes("arbitraryBody"), false);
});
test("permanent placement lag exhausts attempts, persists safe diagnostics and cannot authorize baseline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghfind-readback-"));
  const output = join(directory, "failed.json");
  try {
    const f = fixture("off", {
      bounds: { instanceAttempts: 3, instanceIntervalMs: 1 },
      instances: (result) => ({
        ...result,
        instances: result.instances.map((i) => ({
          ...i,
          state: "inactive",
          version: null,
        })),
      }),
    });
    await assert.rejects(
      verifyProductionToFile(m, sha, image, "off", output, f.options),
      /convergence attempts exhausted/,
    );
    assert.equal(f.count().instanceCalls, 3);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.keepWarm.completed, false);
    assert.equal(report.keepWarm.stopped, true);
    assert.equal(report.stage, "instance_convergence");
    assert.equal(report.instanceObservations.length, 3);
    assert.equal(report.lastValidatedReadiness.length, 3);
    assert.equal(JSON.stringify(report).includes("must-not-upload"), false);
    assert.equal(JSON.stringify(report).includes("arbitraryBody"), false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(
      () => validateReceipt(report, m, sha, image, "off"),
      /matching/,
    );
    assert.throws(
      () => renderRuntime(m, image, sha, "baseline", report),
      /matching/,
    );
    const saved = readFileSync(output, "utf8");
    await assert.rejects(
      verifyProductionToFile(m, sha, image, "off", output, {
        secret: "invalid",
        token,
      }),
      /EEXIST/,
    );
    assert.equal(readFileSync(output, "utf8"), saved);
    const before = f.count().total;
    await sleep(20);
    assert.equal(f.count().total, before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("invalid instance shape or unhealthy placement fails without any retry", async () => {
  for (const instances of [
    () => null,
    (r) => ({ ...r, result_info: undefined }),
    (r) => ({ ...r, instances: [null, null] }),
    (r) => ({
      ...r,
      instances: r.instances.map((i) => ({ ...i, id: "same-id" })),
    }),
    (r) => ({
      ...r,
      instances: r.instances.map((i) => ({ ...i, version: null })),
    }),
    ...["failed", "unhealthy", "unknown", "active"].map((state) => (r) => ({
      ...r,
      instances: r.instances.map((i) => ({ ...i, state })),
    })),
  ]) {
    const f = fixture("off", { instances });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      (error) => {
        assert.equal(error.readbackFailure.instanceObservations.length, 1);
        assert.equal(
          error.readbackFailure.instanceObservations[0].status,
          "rejected",
        );
        return true;
      },
    );
    assert.equal(f.count().instanceCalls, 1);
  }
});
test("instance retry cannot mask wrong actual mode on the next authenticated readiness", async () => {
  const f = fixture("baseline", {
    bounds: { instanceIntervalMs: 1 },
    ready: (r, call) => {
      if (call >= 3) r.containers[1].mode = "off";
      return r;
    },
    instances: (r) => ({
      ...r,
      instances: r.instances.map((i) => ({
        ...i,
        state: "stopped",
        version: 6,
      })),
    }),
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "baseline", f.options),
    /container readiness differs/,
  );
  assert.equal(f.count().instanceCalls, 1);
});
test("per-app deadline cancels waiting or metadata and never accepts a late snapshot", async () => {
  for (const blocked of ["wait", "metadata"]) {
    const f = fixture("off", {
      bounds: { instanceConvergenceMs: 30, instanceIntervalMs: 100 },
      instances: async (r, { signal }) => {
        if (blocked === "metadata") await sleep(1000, undefined, { signal });
        return {
          ...r,
          instances: r.instances.map((i) => ({
            ...i,
            state: "inactive",
            version: null,
          })),
        };
      },
    });
    const start = performance.now();
    await assert.rejects(verifyDeployment(m, sha, image, "off", f.options));
    assert.ok(performance.now() - start < 500);
    assert.equal(f.count().instanceCalls, 1);
    const before = f.count().total;
    await sleep(20);
    assert.equal(f.count().total, before);
  }
});
test("heartbeat failure aborts in-flight convergence metadata without another attempt", async () => {
  const f = fixture("off", {
    bounds: { intervalMs: 5 },
    ready: (r, call) => {
      if (call >= 3) r.containers[0].storageWriterVersion = 1;
      return r;
    },
    instances: async (r, { signal }) => {
      await sleep(1000, undefined, { signal });
      return r;
    },
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    /container readiness differs/,
  );
  assert.equal(f.count().instanceCalls, 1);
  const before = f.count().total;
  await sleep(20);
  assert.equal(f.count().total, before);
});
test("final application snapshot must retain exact application, image and version", async () => {
  for (const patch of [
    { version: 8 },
    { image: "mutable:latest" },
    { id: id(900) },
    { state: "degraded" },
  ]) {
    const f = fixture("off", {
      applications: (apps, call) =>
        call === 2 ? [{ ...apps[0], ...patch }, apps[1]] : apps,
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /application changed during readback/,
    );
    assert.equal(f.count().instanceCalls, 2);
  }
});
test("fixed readback quotas cover both maximum attempt series without widening time or transport bounds", async () => {
  assert.equal(limits.durationMs, 180000);
  assert.equal(limits.metadataReads, 23 + 14 + 14 + 1);
  assert.equal(limits.readinessRequests, 95);
  assert.equal(limits.instanceAttempts, 8);
  assert.equal(limits.instanceConvergenceMs, 60000);
  assert.equal(limits.metadataMs, 30000);
  assert.equal(limits.requestMs, 10000);
  const f = fixture("off", {
    bounds: { instanceIntervalMs: 1 },
    instances: (r, { attempt }) =>
      attempt < 8
        ? {
            ...r,
            instances: r.instances.map((i) => ({
              ...i,
              state: "provisioning",
              version: 7,
            })),
          }
        : r,
  });
  const r = await verifyDeployment(m, sha, image, "off", f.options);
  assert.equal(r.instanceObservations.length, 16);
  assert.equal(r.keepWarm.metadataReads, 38);
  assert.equal(r.keepWarm.readinessRequests, 18);
});
test("both runtime and adapter active deployments must stay fixed through readback", async () => {
  for (const changedWorker of [m.runtimeWorker, m.adapterWorker]) {
    const f = fixture("off", { changedWorker });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /deployment changed/,
    );
  }
});
test("same digest old off process and incompatible writer/epoch/profile are rejected", async () => {
  for (const patch of [
    { mode: "off" },
    { storageWriterVersion: 1 },
    { writerEpoch: 2 },
    { storeProfile: "postgres" },
    { version: "c".repeat(40) },
  ]) {
    const f = fixture("baseline", {
      ready: (r) => {
        Object.assign(r.containers[0], patch);
        return r;
      },
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "baseline", f.options),
      /container readiness differs/,
    );
    assert.equal(f.count().metadataCalls, 0);
  }
  const f = fixture();
  assert.throws(
    () =>
      validateReadiness(
        {
          ...f.ready,
          containers: [
            f.ready.containers[0],
            f.ready.containers[0],
            f.ready.containers[2],
          ],
        },
        m,
        sha,
        image,
        "off",
        id(1),
      ),
    /readiness differs/,
  );
});
test("remote binding drift or public adapter exposure fails before receipt", async () => {
  const transforms = [
    (path, result) => {
      if (path.includes("/versions/"))
        result.resources.bindings.push({ name: "EXTRA", type: "secret_text" });
      return result;
    },
    (path, result) => {
      if (path.includes("adapter-production/versions/"))
        result.resources.bindings.find((b) => b.name === "FEED_DB").id =
          "wrong";
      return result;
    },
    (path, result) => {
      if (path.includes("adapter-production/subdomain")) result.enabled = true;
      return result;
    },
    (path, result) => {
      if (path.includes("/versions/"))
        result.annotations["workers/tag"] = "wrong";
      return result;
    },
  ];
  for (const platform of transforms) {
    const f = fixture("off", { platform });
    await assert.rejects(verifyDeployment(m, sha, image, "off", f.options));
  }
});
test(
  "metadata longer than 10-second executor idle window receives bounded readiness and finally stops",
  { timeout: 15000 },
  async () => {
    const f = fixture("off", { delay: 11000 });
    const r = await verifyDeployment(m, sha, image, "off", f.options);
    assert.ok(r.keepWarm.durationMs >= 11000);
    assert.ok(r.keepWarm.readinessRequests >= 6);
    assert.ok(r.keepWarm.readinessRequests <= limits.readinessRequests);
    assert.equal(r.keepWarm.stopped, true);
    const before = f.count().total;
    await sleep(30);
    assert.equal(f.count().total, before);
  },
);
test("deadline aborts asynchronous metadata and joins heartbeat without a late success", async () => {
  const f = fixture("off", {
    delay: 1000,
    bounds: { durationMs: 65, intervalMs: 10 },
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    /deadline/,
  );
  const before = f.count().total;
  await sleep(30);
  assert.equal(f.count().total, before);
  const g = fixture("off", { bounds: { readinessRequests: 100000 } });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", g.options),
    /tightened/,
  );
});

test("remote application size or image drift cannot be hidden by healthy fixed instances", async () => {
  for (const appInfo of [
    (r) => ({ ...r, max_instances: 20 }),
    (r) => ({
      ...r,
      configuration: { ...r.configuration, instance_type: "standard" },
    }),
    (r) => ({
      ...r,
      configuration: { ...r.configuration, image: "mutable:latest" },
    }),
  ]) {
    const f = fixture("off", { appInfo });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /capacity\/image differs/,
    );
  }
});

test("a healthy application with the wrong Durable Object namespace cannot stand in for the actual runtime", async () => {
  const f = fixture("off", {
    appInfo: (r) => ({ ...r, durable_objects: { namespace_id: id(999) } }),
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    /not linked/,
  );
});

test("actual async wiring is checked for off and baseline and retains only policy evidence", async () => {
  for (const mode of ["off", "baseline"]) {
    const f = fixture(mode),
      r = await verifyDeployment(m, sha, image, mode, f.options);
    assert.equal(r.keepWarm.metadataReads, 24);
    assert.equal(r.asyncTriggers.verified, true);
    assert.equal(r.asyncTriggers.mode, mode);
    assert.deepEqual(
      r.asyncTriggers.schedules,
      mode === "baseline" ? ["* * * * *"] : [],
    );
    assert.deepEqual(
      r.asyncTriggers.queues.map((q) => q.consumers.length),
      mode === "baseline" ? [1, 1, 0] : [0, 0, 0],
    );
    assert.deepEqual(
      r.asyncTriggers.queues.map((q) => q.retentionSeconds),
      [345600, 345600, 1209600],
    );
    assert.equal(JSON.stringify(r).includes("must-not-upload"), false);
  }
});
test("off rejects leftover or foreign queue consumers and any actual cron", async () => {
  const leftover = {
    consumer_id: "a".repeat(32),
    type: "worker",
    script_name: m.runtimeWorker,
  };
  for (const who of [
    leftover,
    { ...leftover, script_name: "foreign-worker" },
    { type: "http_pull" },
  ]) {
    const f = fixture("off", {
      queue: (path, result) => {
        if (path.endsWith("/consumers")) return [who];
        if (result.consumers)
          return { ...result, consumers: [who], consumers_total_count: 1 };
        return result;
      },
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "off", f.options),
      /consumer population/,
    );
  }
  const f = fixture("off", {
    platform: (path, result) =>
      path.endsWith("/schedules")
        ? { schedules: [{ cron: "* * * * *" }] }
        : result,
  });
  await assert.rejects(
    verifyDeployment(m, sha, image, "off", f.options),
    /cron/,
  );
});
test("baseline rejects foreign, pull, duplicate, stale or expanded consumer policy", async () => {
  for (const change of [
    (c) => ({ ...c, script_name: "foreign" }),
    (c) => ({ ...c, type: "http_pull" }),
    (c) => ({ ...c, dead_letter_queue: m.queue }),
    (c) => ({ ...c, settings: { ...c.settings, batch_size: 2 } }),
    (c) => ({ ...c, settings: { ...c.settings, max_concurrency: null } }),
    (c) => ({ ...c, settings: { ...c.settings, max_retries: 6 } }),
    (c) => ({ ...c, settings: { ...c.settings, max_wait_time_ms: 10000 } }),
    (c) => ({ ...c, service: "foreign" }),
    (c) => ({ ...c, service: m.runtimeWorker, environment: "staging" }),
  ]) {
    const f = fixture("baseline", {
      queue: (path, result) =>
        path.endsWith("/consumers") ? result.map(change) : result,
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "baseline", f.options),
      /consumer policy/,
    );
  }
  for (const change of [
    (_rows) => [],
    (rows) => [...rows, ...rows],
    (rows) => rows.map((c) => ({ ...c, consumer_id: "b".repeat(32) })),
  ]) {
    const f = fixture("baseline", {
      queue: (path, result) =>
        path.endsWith("/consumers") ? change(result) : result,
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "baseline", f.options),
      /snapshot/,
    );
  }
});
test("queue lookup, retention, pause and exact cron evidence cannot default to success", async () => {
  for (const change of [
    (r) => ({
      ...r,
      settings: { ...r.settings, message_retention_period: 3600 },
    }),
    (r) => ({ ...r, settings: { ...r.settings, delivery_paused: true } }),
    (r) => ({ ...r, settings: { ...r.settings, delivery_delay: 10 } }),
    (r) => ({ ...r, consumers_total_count: 20 }),
    (r) => ({ ...r, consumers: undefined }),
  ]) {
    const f = fixture("baseline", {
      queue: (path, result) => (result.settings ? change(result) : result),
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "baseline", f.options),
      /settings|snapshot/,
    );
  }
  for (const queue of [
    (path, r) => (path === "/queues" ? [] : r),
    (path, r) => (path === "/queues" ? [...r, ...r] : r),
    (path, r) =>
      path === "/queues" ? [{ ...r[0], queue_name: "foreign" }] : r,
  ]) {
    const f = fixture("baseline", { queue });
    await assert.rejects(
      verifyDeployment(m, sha, image, "baseline", f.options),
      /missing or ambiguous/,
    );
  }
  for (const schedules of [
    {},
    { schedules: [] },
    { schedules: [{ cron: "* * * * *" }, { cron: "0 * * * *" }] },
    { schedules: [{ cron: "*/5 * * * *" }] },
  ]) {
    const f = fixture("baseline", {
      platform: (path, r) => (path.endsWith("/schedules") ? schedules : r),
    });
    await assert.rejects(
      verifyDeployment(m, sha, image, "baseline", f.options),
      /cron/,
    );
  }
});
test("documented script_name and pinned Wrangler legacy script/service agree without granting another environment", async () => {
  for (const alias of [
    (c) => {
      const { script_name: _name, ...rest } = c;
      return { ...rest, script: m.runtimeWorker };
    },
    (c) => {
      const { script_name: _name, ...rest } = c;
      return { ...rest, service: m.runtimeWorker, environment: "production" };
    },
  ]) {
    const f = fixture("baseline", {
      queue: (path, result) => {
        if (path.endsWith("/consumers")) return result.map(alias);
        if (result.consumers)
          return { ...result, consumers: result.consumers.map(alias) };
        return result;
      },
    });
    assert.equal(
      (await verifyDeployment(m, sha, image, "baseline", f.options))
        .asyncTriggers.verified,
      true,
    );
  }
});

const productionActions = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "hikariming/ghfind",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF:
    "hikariming/ghfind/.github/workflows/deploy-cf-production.yml@refs/heads/main",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  CLOUDFLARE_API_TOKEN: "synthetic-cf-token-".repeat(3),
};
function consumerDetachFixture({
  empty = false,
  mutate = () => {},
  failure,
  retained = false,
} = {}) {
  const queues = [m.queue, m.deadLetterQueue].map((name, index) => ({
    name,
    id: String(index + 1).repeat(32),
    reads: 0,
    consumers: empty
      ? []
      : [
          {
            consumer_id: String(index + 3).repeat(32),
            type: "worker",
            script_name: m.runtimeWorker,
            environment: "production",
          },
        ],
  }));
  const calls = [];
  return {
    queues,
    calls,
    options: {
      env: productionActions,
      fetcher: async (url, options) => {
        const request = new URL(url);
        assert.equal(request.origin, "https://api.cloudflare.com");
        assert.equal(
          options.headers.authorization,
          `Bearer ${productionActions.CLOUDFLARE_API_TOKEN}`,
        );
        assert.equal(options.redirect, "error");
        assert.equal(options.signal.aborted, false);
        const path = request.pathname.replace(
          `/client/v4/accounts/${m.accountId}`,
          "",
        );
        calls.push({ method: options.method, path });
        let result;
        if (path === "/queues") {
          assert.equal(options.method, "GET");
          const q = queues.find(
            (q) => q.name === request.searchParams.get("name"),
          );
          assert.ok(q, "only the two pinned queues may be read");
          result = [{ queue_name: q.name, queue_id: q.id }];
        } else {
          const q = queues.find((q) =>
            path.startsWith(`/queues/${q.id}/consumers`),
          );
          assert.ok(
            q,
            "must not access/delete queue, messages, parking, or arbitrary resources",
          );
          if (options.method === "DELETE") {
            assert.ok(
              queues.every((v) => v.reads >= 1),
              "both owners must be verified before mutation",
            );
            assert.equal(
              path,
              `/queues/${q.id}/consumers/${q.consumers[0]?.consumer_id}`,
            );
            if (failure === "delete")
              throw new Error("synthetic transport timeout");
            if (!retained) q.consumers = [];
            result = null;
          } else {
            assert.equal(options.method, "GET");
            assert.equal(path, `/queues/${q.id}/consumers`);
            q.reads++;
            result = structuredClone(q.consumers);
            mutate(q, result);
          }
        }
        return Response.json(
          { success: failure !== "api", result },
          { status: failure === "api" ? 403 : 200 },
        );
      },
    },
  };
}
test("consumer detach is production Actions-only before any API request", async () => {
  for (const changed of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "other/repo" },
    { GITHUB_REF: "refs/heads/dev" },
    {
      GITHUB_WORKFLOW_REF:
        "hikariming/ghfind/.github/workflows/ci.yml@refs/heads/main",
    },
    { CLOUDFLARE_API_TOKEN: "" },
  ]) {
    const f = consumerDetachFixture();
    await assert.rejects(
      disableConsumers(m, {
        ...f.options,
        env: { ...productionActions, ...changed },
      }),
    );
    assert.equal(f.calls.length, 0);
  }
});
test("detaches only owned subscriptions and independently verifies empty final inventories", async () => {
  for (const empty of [false, true]) {
    const f = consumerDetachFixture({ empty });
    const r = await disableConsumers(m, f.options);
    assert.equal(r.status, "passed");
    assert.equal(r.consumersAbsent, true);
    assert.equal(r.removed.length, empty ? 0 : 2);
    assert.equal(r.requests, empty ? 8 : 10);
    assert.equal(r.messagesDeleted, false);
    assert.equal(r.queuesDeleted, false);
    assert.equal(r.runId, "123");
    assert.equal(
      JSON.stringify(r).includes(productionActions.CLOUDFLARE_API_TOKEN),
      false,
    );
    assert.equal(
      f.calls.filter((c) => c.method === "DELETE").length,
      empty ? 0 : 2,
    );
  }
});
test("a foreign or ambiguous second consumer blocks deletion from both queues", async () => {
  for (const change of [
    (c) => {
      c.script_name = "foreign-worker";
    },
    (c) => {
      c.script = "foreign-worker";
    },
    (c) => {
      c.environment = "staging";
    },
    (c) => {
      c.type = "http_pull";
    },
    (c) => {
      delete c.script_name;
    },
    (c) => {
      c.consumer_id = "not-a-queue-id";
    },
    (c) => {
      c.queue_name = "foreign-queue";
    },
  ]) {
    const f = consumerDetachFixture({
      mutate(q, rows) {
        if (q.name === m.deadLetterQueue && rows.length) change(rows[0]);
      },
    });
    await assert.rejects(
      disableConsumers(m, f.options),
      (error) =>
        error.receipt.status === "failed" && error.receipt.removed.length === 0,
    );
    assert.equal(
      f.calls.some((c) => c.method === "DELETE"),
      false,
    );
  }
  const f = consumerDetachFixture({
    mutate(_q, rows) {
      rows.push({ ...rows[0] });
    },
  });
  await assert.rejects(disableConsumers(m, f.options));
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
});
test("ownership aliases agree and identity changes before DELETE fail closed", async () => {
  for (const alias of ["script", "service"]) {
    const f = consumerDetachFixture({
      mutate(_q, rows) {
        for (const c of rows) {
          c[alias] = c.script_name;
          delete c.script_name;
        }
      },
    });
    assert.equal((await disableConsumers(m, f.options)).status, "passed");
  }
  const f = consumerDetachFixture({
    mutate(q, rows) {
      if (q.reads === 2 && rows.length) rows[0].consumer_id = "f".repeat(32);
    },
  });
  await assert.rejects(disableConsumers(m, f.options));
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
});
test("uncertain DELETE and incomplete post-readback never produce a passed receipt", async () => {
  for (const options of [
    { failure: "api" },
    { failure: "delete" },
    { retained: true },
  ]) {
    const f = consumerDetachFixture(options);
    await assert.rejects(disableConsumers(m, f.options), (error) => {
      assert.equal(error.receipt.status, "failed");
      assert.equal(error.receipt.consumersAbsent, false);
      if (options.failure === "delete") {
        assert.equal(error.receipt.deleteAttempts.length, 1);
        assert.equal(error.receipt.removed.length, 0);
      }
      assert.ok(error.receipt.requests <= 14);
      return true;
    });
  }
});
