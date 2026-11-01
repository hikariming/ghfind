import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_PAGE_SIZE } from "../src/admin-data";
import {
  GLOBAL_ACCOUNT_PAGE_SIZE,
  loadGlobalAdminData,
  type GlobalRepositoryScope,
} from "../src/admin-global-data";
import { ApiError, type github } from "../src/github";
import { putSettings } from "../src/settings";

declare const TEST_SQL: string[];
const e = env as Env;
const now = Date.UTC(2026, 9, 7, 12);
const windowStart = now - 30 * 86400_000;
const accounts = [
  { id: 10, account: "alpha" },
  { id: 20, account: "beta" },
];
const maps = new Map([
  [
    10,
    new Map([
      [100, "alpha/one"],
      [101, "alpha/read-only"],
      [102, "alpha/transferred"],
    ]),
  ],
  [
    20,
    new Map([
      [200, "beta/writer"],
      [201, "beta/new-owner"],
      [202, "beta/renamed"],
    ]),
  ],
]);
const names = new Map([...maps.values()].flatMap((map) => [...map]));
const membership = (scopes = maps) =>
  vi.fn(
    async (
      installation: number,
      page: number,
    ): Promise<GlobalRepositoryScope> => {
      const all = scopes.get(installation);
      if (!all) throw new Error("Unexpected installation membership callback");
      return {
        repositories: new Map(
          [...all].slice((page - 1) * ADMIN_PAGE_SIZE, page * ADMIN_PAGE_SIZE),
        ),
        totalAccessible: all.size,
        hasNext: page * ADMIN_PAGE_SIZE < all.size,
      };
    },
  );
const permissions = (
  repos = names,
  overrides = new Map<number, Record<string, unknown> | ApiError>(),
) =>
  vi.fn<ReturnType<typeof github>>(async (path) => {
    const item = [...repos].find(
      ([, fullName]) => `/repos/${fullName}` === path,
    );
    if (!item) throw new Error("Unexpected permission endpoint");
    const override = overrides.get(item[0]);
    if (override instanceof ApiError) throw override;
    return (
      override || {
        id: item[0],
        full_name: item[1],
        permissions: { admin: true },
      }
    );
  });
const load = (
  params = "",
  installs = accounts,
  scope = membership(),
  api = permissions(),
  at = now,
) =>
  loadGlobalAdminData(e, api, installs, scope, new URLSearchParams(params), at);
async function job(
  id: string,
  repository: number,
  installation: number,
  state = "done",
  updated = now,
  extra: { fullName?: string; due?: number; lease?: number; pr?: number } = {},
) {
  await e.DB.prepare(
    `INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,result,created,due,lease,updated)
    VALUES(?,?,?,?,?,'label',?,?, ?,?,?,?)`,
  )
    .bind(
      id,
      installation,
      repository,
      extra.fullName || names.get(repository) || "hidden/repo",
      extra.pr ?? null,
      state,
      `result-${id}`,
      updated,
      extra.due ?? now,
      extra.lease ?? 0,
      updated,
    )
    .run();
}
async function audit(repository: number, actor: string, created = now) {
  await e.DB.prepare(
    "INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(?,?,'web','settings.update','{}',?)",
  )
    .bind(repository, actor, created)
    .run();
}
async function cleanup(
  id: string,
  repository: number,
  installation: number,
  state = "running",
  expires = now + 1000,
  updated = now,
  fullName = names.get(repository) || "hidden/repo",
) {
  await e.DB.prepare(
    `INSERT INTO cleanups(id,installation,repository,full_name,scope,state,code_hash,requested_by,created,updated,expires)
    VALUES(?,?,?,?,'{}',?,'private-hash-not-display-data','admin',?,?,?)`,
  )
    .bind(
      id,
      installation,
      repository,
      fullName,
      state,
      updated,
      updated,
      expires,
    )
    .run();
}
async function saved(
  repository: number,
  installation: number,
  fullName: string,
  active: boolean,
  triage: boolean,
  prompt = "",
) {
  await putSettings(
    e,
    installation,
    repository,
    fullName,
    {
      issuesEnabled: active,
      prsEnabled: false,
      commentsEnabled: !!prompt,
      commentPrompt: prompt,
      triageEnabled: triage,
      allowedLabels: triage ? ["bug"] : [],
    },
    "fixture-admin",
  );
}
async function snapshot() {
  return Promise.all(
    ["jobs", "repo_settings", "audit_log", "cleanups"].map(
      async (table) =>
        (await e.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
    ),
  );
}
beforeAll(async () => {
  for (const sql of TEST_SQL) await e.DB.prepare(sql).run();
});
beforeEach(async () => {
  await e.DB.exec(
    "DELETE FROM jobs; DELETE FROM repo_settings; DELETE FROM audit_log; DELETE FROM cleanups;",
  );
});

describe("authenticated bounded global dashboard data", () => {
  it("aggregates only live writable memberships and attaches the correct installation to every displayed row without writes", async () => {
    await saved(100, 10, "alpha/one", true, true);
    await saved(200, 20, "beta/writer", false, false);
    await saved(
      201,
      20,
      "previous/new-owner",
      false,
      true,
      "old-owner-private-prompt",
    );
    await saved(202, 9, "BETA/old-name", true, true, "same-owner-prompt");
    await job("alpha-visible", 100, 10, "failed");
    await job("beta-visible", 200, 20, "pending");
    await job("rename-visible", 202, 20, "done", now, {
      fullName: "BETA/old-name",
    });
    await job("other-installation-secret", 100, 20);
    await job("read-only-secret", 101, 10);
    await job("live-transfer-secret", 102, 10);
    await job("previous-owner-secret", 201, 20, "done", now, {
      fullName: "previous/new-owner",
    });
    await job("outside-membership-secret", 999, 10);
    await audit(100, "alpha-admin");
    await audit(200, "beta-writer");
    await audit(202, "same-owner");
    await audit(101, "read-only-secret");
    await audit(201, "previous-owner-secret");
    await cleanup("alpha-cleanup", 100, 10);
    await cleanup("beta-cleanup", 200, 20);
    await cleanup("wrong-installation-cleanup", 100, 20);
    await cleanup("read-only-cleanup", 101, 10);
    const before = await snapshot();
    const api = permissions(
      names,
      new Map([
        [101, { id: 101, full_name: "alpha/read-only", permissions: {} }],
        [
          102,
          {
            id: 102,
            full_name: "new-owner/transferred",
            permissions: { admin: true },
          },
        ],
        [
          200,
          { id: 200, full_name: "beta/writer", permissions: { push: true } },
        ],
      ]),
    );
    const scope = membership();
    const data = await load("", accounts, scope, api);
    expect(scope.mock.calls).toEqual([
      [10, 1],
      [20, 1],
    ]);
    expect(api).toHaveBeenCalledTimes(6);
    expect(
      data.repositories.map((row) => [
        row.id,
        row.installation,
        row.account,
        row.admin,
      ]),
    ).toEqual([
      [100, 10, "alpha", true],
      [200, 20, "beta", false],
      [201, 20, "beta", true],
      [202, 20, "beta", true],
    ]);
    expect(data.overview).toMatchObject({
      totalJobs: 3,
      jobStates: { failed: 1, pending: 1, done: 1 },
      totalCleanups: 2,
    });
    expect(
      data.tasks.rows
        .map((row) => [row.id, row.installation, row.repository])
        .sort(),
    ).toEqual([
      ["alpha-visible", 10, 100],
      ["beta-visible", 20, 200],
      ["rename-visible", 20, 202],
    ]);
    expect(
      data.activity.rows.map((row) => [row.actor, row.installation]).sort(),
    ).toEqual([
      ["alpha-admin", 10],
      ["beta-writer", 20],
      ["same-owner", 20],
    ]);
    expect(
      data.cleanups.map((row) => [row.id, row.installation]).sort(),
    ).toEqual([
      ["alpha-cleanup", 10],
      ["beta-cleanup", 20],
    ]);
    expect(
      data.repositories.find((row) => row.id === 201)?.settings,
    ).toMatchObject({
      triageEnabled: false,
      commentsEnabled: false,
      commentPrompt: "",
    });
    expect(
      data.repositories.find((row) => row.id === 202)?.settings.commentPrompt,
    ).toBe("same-owner-prompt");
    expect(data.accounts).toEqual([
      {
        id: 10,
        account: "alpha",
        accessible: 3,
        checked: 3,
        writable: 1,
        admin: 1,
        processing: 1,
        paused: 0,
        triage: 1,
        failed: 1,
        pending: 0,
        running: 0,
        partial: false,
      },
      {
        id: 20,
        account: "beta",
        accessible: 3,
        checked: 3,
        writable: 3,
        admin: 2,
        processing: 2,
        paused: 1,
        triage: 1,
        failed: 0,
        pending: 1,
        running: 0,
        partial: false,
      },
    ]);
    expect(JSON.stringify(data)).not.toMatch(
      /secret|private-hash|old-owner-private/,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("sums actual 30-day counts and due/lease states while retaining older history and reporting expired previews", async () => {
    const scopes = new Map([
      [10, new Map([[100, "alpha/one"]])],
      [20, new Map([[200, "beta/writer"]])],
    ]);
    await job("before-window", 100, 10, "done", windowStart - 1);
    await job("at-window-start", 100, 10, "done", windowStart);
    await job("after-now", 200, 20, "failed", now + 1);
    await job("due-now", 100, 10, "pending", now, { due: now });
    await job("due-later", 200, 20, "pending", now, { due: now + 1 });
    await job("leased", 100, 10, "running", now, { lease: now + 1 });
    await job("stale", 200, 20, "running", now, { lease: now });
    await cleanup("expired-preview", 100, 10, "planned", now);
    await cleanup("older-cleanup", 200, 20, "done", now + 1, windowStart - 1);
    await cleanup("at-window-cleanup", 200, 20, "done", now + 1, windowStart);
    const data = await load("", accounts, membership(scopes));
    expect(data.overview).toMatchObject({
      since: windowStart,
      until: now,
      totalJobs: 5,
      jobStates: { pending: 2, running: 2, done: 1, failed: 0 },
      duePending: 1,
      leasedRunning: 1,
      staleRunning: 1,
      totalCleanups: 2,
      cleanupStates: { expired: 1, done: 1, planned: 0 },
    });
    expect(data.tasks.rows).toHaveLength(7);
    expect(data.cleanups).toHaveLength(3);
    expect(
      data.cleanups.find((row) => row.id === "expired-preview")?.state,
    ).toBe("expired");
    expect(
      (
        await e.DB.prepare(
          "SELECT state FROM cleanups WHERE id='expired-preview'",
        ).first()
      )?.state,
    ).toBe("planned");
  });

  it("checks at most four accounts and 25 repositories each, with honest account/repository pagination", async () => {
    const installs = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      account: `tenant${index + 1}`,
    }));
    const scopes = new Map(
      installs.map((account) => [
        account.id,
        new Map(
          Array.from({ length: 60 }, (_, index) => [
            account.id * 1000 + index + 1,
            `${account.account}/repo-${index + 1}`,
          ]),
        ),
      ]),
    );
    const allNames = new Map([...scopes.values()].flatMap((map) => [...map]));
    const scope = membership(scopes),
      api = permissions(allNames);
    const first = await load("repo_page=2", installs, scope, api);
    expect(GLOBAL_ACCOUNT_PAGE_SIZE).toBe(4);
    expect(scope.mock.calls).toEqual([
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ]);
    expect(api).toHaveBeenCalledTimes(100);
    expect(first.repositories).toHaveLength(100);
    expect(first.scope).toMatchObject({
      page: 2,
      totalAccessible: 240,
      checked: 100,
      authorized: 100,
      hasPrevious: true,
      hasNext: true,
      partial: true,
    });
    expect(first.globalScope).toMatchObject({
      installationPage: 1,
      installationPageSize: 4,
      totalInstallations: 6,
      checkedInstallations: 4,
      hasPrevious: false,
      hasNext: true,
      partial: true,
    });
    expect(
      first.repositories.every(
        (row) =>
          row.id % 1000 >= 26 && row.id % 1000 <= 50 && row.installation! <= 4,
      ),
    ).toBe(true);
    expect(
      api.mock.calls.some(
        ([path]) => path.includes("tenant5") || path.includes("tenant6"),
      ),
    ).toBe(false);
    const secondApi = permissions(allNames),
      secondScope = membership(scopes);
    const second = await load(
      "account_page=2&repo_page=3",
      installs,
      secondScope,
      secondApi,
    );
    expect(secondScope.mock.calls).toEqual([
      [5, 3],
      [6, 3],
    ]);
    expect(secondApi).toHaveBeenCalledTimes(20);
    expect(second.globalScope).toMatchObject({
      installationPage: 2,
      checkedInstallations: 2,
      hasPrevious: true,
      hasNext: false,
      partial: true,
    });
    expect(second.scope).toMatchObject({
      checked: 20,
      hasNext: false,
      hasPrevious: true,
      partial: true,
    });
  });

  it.each([403, 404])(
    "marks a vanished installation HTTP %s as incomplete without exposing its old rows",
    async (status) => {
      await job("vanished-secret", 100, 10);
      await job("visible", 200, 20);
      const scope = vi.fn(
        async (installation: number): Promise<GlobalRepositoryScope> => {
          if (installation === 10) throw new ApiError(status, false);
          return {
            repositories: new Map([[200, "beta/writer"]]),
            totalAccessible: 1,
            hasNext: false,
          };
        },
      );
      const api = permissions();
      const data = await load("", accounts, scope, api);
      expect(data.globalScope.partial).toBe(true);
      expect(data.scope.partial).toBe(true);
      expect(data.accounts[0]).toMatchObject({
        id: 10,
        checked: 0,
        writable: 0,
        partial: true,
      });
      expect(data.overview.totalJobs).toBe(1);
      expect(data.tasks.rows.map((row) => row.id)).toEqual(["visible"]);
      expect(api).toHaveBeenCalledExactlyOnceWith("/repos/beta/writer");
    },
  );

  it("propagates retryable/quota membership and live permission failures instead of manufacturing a successful global total", async () => {
    for (const error of [
      new ApiError(403, true, 60000, true),
      new ApiError(404, true),
      new ApiError(500, true),
    ]) {
      const scope = vi.fn(async (): Promise<GlobalRepositoryScope> => {
        throw error;
      });
      const api = permissions();
      await expect(load("", accounts, scope, api)).rejects.toBe(error);
      expect(api).not.toHaveBeenCalled();
    }
    const quota = new ApiError(403, true, 60000, true);
    await expect(
      load(
        "",
        [{ id: 10, account: "alpha" }],
        membership(new Map([[10, new Map([[100, "alpha/one"]])]])),
        permissions(names, new Map([[100, quota]])),
      ),
    ).rejects.toBe(quota);
  });

  it("fails closed for duplicate repository IDs across selected installations while preserving unrelated authorized rows", async () => {
    const scopes = new Map([
      [
        10,
        new Map([
          [100, "alpha/one"],
          [101, "alpha/read-only"],
        ]),
      ],
      [
        20,
        new Map([
          [100, "alpha/one"],
          [200, "beta/writer"],
        ]),
      ],
    ]);
    await job("ambiguous-alpha-secret", 100, 10);
    await job("ambiguous-beta-secret", 100, 20);
    await audit(100, "ambiguous-secret");
    await cleanup("ambiguous-cleanup", 100, 10);
    await job("unambiguous-alpha", 101, 10);
    await job("unambiguous-beta", 200, 20);
    const api = permissions();
    const data = await load("", accounts, membership(scopes), api);
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/repos/alpha/read-only",
      "/repos/beta/writer",
    ]);
    expect(data.scope).toMatchObject({
      totalAccessible: 4,
      checked: 2,
      authorized: 2,
      partial: true,
    });
    expect(data.globalScope.partial).toBe(true);
    expect(data.repositories.map((row) => row.id)).toEqual([101, 200]);
    expect(data.tasks.rows.map((row) => row.id)).toEqual([
      "unambiguous-alpha",
      "unambiguous-beta",
    ]);
    expect(data.overview.totalJobs).toBe(2);
    expect(JSON.stringify(data)).not.toMatch(
      /ambiguous-alpha-secret|ambiguous-beta-secret|ambiguous-secret|ambiguous-cleanup/,
    );
  });

  it("returns an explicit empty state and validates dashboard/account context before invoking any callbacks", async () => {
    const scope = membership(),
      api = permissions();
    const empty = await load("", [], scope, api);
    expect(empty.globalScope).toMatchObject({
      totalInstallations: 0,
      checkedInstallations: 0,
      partial: false,
    });
    expect(empty.overview.totalJobs).toBe(0);
    expect(empty.repositories).toEqual([]);
    expect(empty.accounts).toEqual([]);
    expect(scope).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    for (const query of [
      "account_page=0",
      "account_page=2",
      "account_page=1&account_page=1",
      "account_page=1.5",
      "account_page=251",
      "repo_page=0",
      "q=%00",
      "task_page=401",
    ]) {
      await expect(load(query, accounts, scope, api)).rejects.toThrow(
        /Invalid/,
      );
    }
    for (const installs of [
      [{ id: 0, account: "invalid" }],
      [{ id: -1, account: "invalid" }],
      [
        { id: 10, account: "alpha" },
        { id: 10, account: "duplicate" },
      ],
    ])
      await expect(load("", installs, scope, api)).rejects.toThrow(
        /Invalid|Duplicate/,
      );
    for (const at of [NaN, Infinity, windowStart / 100000, now + 0.5])
      await expect(load("", accounts, scope, api, at)).rejects.toThrow(
        /Invalid/,
      );
    expect(scope).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects oversized, invalid-total and invalid-identifier scope responses before live permission checks", async () => {
    const invalidScopes: GlobalRepositoryScope[] = [
      {
        repositories: new Map(
          Array.from({ length: 26 }, (_, index) => [
            index + 1,
            `alpha/repo-${index}`,
          ]),
        ),
        totalAccessible: 26,
        hasNext: false,
      },
      {
        repositories: new Map([[100, "alpha/one"]]),
        totalAccessible: 0,
        hasNext: false,
      },
      { repositories: new Map(), totalAccessible: NaN, hasNext: false },
      { repositories: new Map(), totalAccessible: -1, hasNext: false },
      {
        repositories: new Map([[0, "alpha/invalid"]]),
        totalAccessible: 1,
        hasNext: false,
      },
    ];
    for (const invalid of invalidScopes) {
      const scope = vi.fn(async () => invalid),
        api = permissions();
      await expect(
        load("", [{ id: 10, account: "alpha" }], scope, api),
      ).rejects.toThrow(/Invalid/);
      expect(api).not.toHaveBeenCalled();
    }
  });
});
