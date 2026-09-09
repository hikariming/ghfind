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
  disableConsumers,
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
  assert.equal(r.keepWarm.metadataReads, 23);
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

test("actual async wiring is checked for off and baseline and retains only policy evidence", async () => {
  for (const mode of ["off", "baseline"]) {
    const f = fixture(mode),
      r = await verifyDeployment(m, sha, image, mode, f.options);
    assert.equal(r.keepWarm.metadataReads, 23);
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
