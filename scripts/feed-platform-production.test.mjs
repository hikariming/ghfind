import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  template,
  validateManifest,
  renderRuntime,
  renderAdapter,
  validateReceipt,
  expectedBindings,
  validateReadiness,
} from "./feed-platform-production.mjs";
import {
  validateManifest as stagingValidate,
  template as stagingTemplate,
} from "./feed-platform-manifest.mjs";
import {
  verifyDeployment,
  limits,
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
    metadataCalls = 0;
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
      return Response.json(
        options.ready
          ? options.ready(structuredClone(ready), readyCalls)
          : ready,
      );
    }
    assert.equal(u.origin, "https://api.cloudflare.com");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    const path = u.pathname.split(`/accounts/${m.accountId}`)[1];
    const match =
      /^\/workers\/scripts\/(ghfind-feed-(?:runtime|adapter)-production)\/(deployments|versions\/[^/]+|subdomain)$/.exec(
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
    version: 7,
    env: { SECRET: "must-not-upload" },
  }));
  const metadata = async (args, { signal }) => {
    metadataCalls++;
    assert.ok(signal instanceof AbortSignal);
    if (options.delay && metadataCalls === 1)
      await sleep(options.delay, undefined, { signal });
    if (args[1] === "list") return applications;
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
    return {
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
    },
    count: () => ({ total, readyCalls, metadataCalls }),
    ready,
  };
}

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
  assert.equal(c.triggers, undefined);
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
  assert.equal(r.keepWarm.metadataReads, 13);
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
