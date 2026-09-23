import { enqueueAuthorEmail, scoreContext } from "./author-email";
import {
  ApiError,
  appJWT,
  github,
  installationToken,
  jsonRequest,
  positive,
  record,
  repositoryName,
} from "./github";
import {
  initializeLabels,
  labels,
  LABELS,
  scoreToLabel,
  syncLabel,
} from "./review";

export interface Job {
  id: string;
  installation: number;
  repository: number | null;
  full_name: string | null;
  // GitHub issues and PRs share the same repository number namespace.
  pr: number | null;
  kind: "discover" | "initialize" | "label";
  state: string;
  attempts: number;
  created: number;
  started: number;
  due: number;
  lease: number;
  score: string | null;
  score_context?: string | null;
  page: number;
  result: string | null;
  updated: number;
}
export function allowed(env: Env, fullName: string) {
  const accounts = env.ALLOWED_ACCOUNTS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return (
    accounts.includes("*") ||
    accounts.includes(fullName.split("/")[0].toLowerCase())
  );
}
export async function putJob(
  env: Env,
  input: Pick<Job, "id" | "installation" | "kind"> &
    Partial<Pick<Job, "repository" | "full_name" | "pr" | "due">>,
) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO jobs(id,installation,repository,full_name,pr,kind,created,due,updated) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      input.id,
      input.installation,
      input.repository ?? null,
      input.full_name ?? null,
      input.pr ?? null,
      input.kind,
      now,
      input.due ?? now,
      now,
    )
    .run();
}
// Two automatic attempts, 20 and 60 minutes after the first transient no-score.
// Nothing is scheduled after that; the author or an admin mentions the bot.
const RESCORE_AFTER_MS = [20 * 60_000, 60 * 60_000];
export function rescoreGeneration(id: string): number {
  const match = /^rescore-([12])-/.exec(id);
  return match ? Number(match[1]) : 0;
}
async function scheduleRescore(env: Env, job: Job) {
  if (
    rescoreGeneration(job.id) > 0 ||
    job.repository == null ||
    job.pr == null
  )
    return;
  const now = Date.now();
  for (let index = 0; index < RESCORE_AFTER_MS.length; index++) {
    await putJob(env, {
      id: `rescore-${index + 1}-${job.installation}-${job.repository}-${job.pr}`,
      installation: job.installation,
      kind: "label",
      repository: job.repository,
      full_name: job.full_name,
      pr: job.pr,
      due: now + RESCORE_AFTER_MS[index],
    });
  }
}
export function mentionsBot(body: string, slug: string): boolean {
  if (!/^[A-Za-z0-9-]+$/.test(slug) || body.length > 65536) return false;
  return new RegExp(
    `(?:^|[^A-Za-z0-9-])@${slug}(?:\\[bot\\])?(?=$|[^A-Za-z0-9-])`,
    "i",
  ).test(body);
}
export async function admitMention(
  env: Env,
  delivery: string,
  payload: Record<string, unknown>,
) {
  if (payload.action !== "created") return;
  const comment = record(payload.comment);
  const user = record(comment.user);
  if (typeof comment.body !== "string" || typeof user.login !== "string")
    return;
  if (
    user.type === "Bot" ||
    user.login === `${env.APP_SLUG}[bot]` ||
    !mentionsBot(comment.body, env.APP_SLUG) ||
    !/^[A-Za-z0-9-]+$/.test(user.login)
  )
    return;
  const repo = record(payload.repository);
  const fullName = repositoryName(repo.full_name);
  if (!allowed(env, fullName)) return;
  const issue = record(payload.issue);
  // Mentions on pull requests are paused with the rest of PR review. GitHub
  // delivers them as issue_comment events with issue.pull_request set. Do not
  // read the PR author or enqueue a rescore; that job would label and email.
  if (issue.pull_request) return;
  const author = record(issue.user);
  const installation = positive(record(payload.installation).id);
  const number = positive(issue.number);
  const repository = positive(repo.id);
  const isAuthor =
    author.login === user.login &&
    author.type !== "Bot" &&
    typeof author.login === "string";
  const api = github(await installationToken(env, installation, repository));
  if (!isAuthor) {
    let permission: Record<string, unknown>;
    try {
      permission = record(
        await api(
          `/repos/${fullName}/collaborators/${encodeURIComponent(user.login)}/permission`,
        ),
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404)
      )
        return;
      throw error;
    }
    if (permission.permission !== "admin") return;
  }
  const applied = await labels(
    api,
    `/repos/${fullName}/issues/${number}/labels`,
  );
  if (!applied.has(LABELS[4])) return;
  await putJob(env, {
    id: `mention-${delivery}`,
    installation,
    kind: "label",
    repository,
    full_name: fullName,
    pr: number,
  });
}
export async function dispatch(env: Env) {
  if (env.ENABLED !== "true") return;
  const now = Date.now();
  // SQL is the durable outbox: queue-send failures are recovered by cron.
  const { results } = await env.DB.prepare(
    "SELECT id FROM jobs WHERE (state='pending' AND due<=?) OR (state='running' AND lease<?) ORDER BY due LIMIT 100",
  )
    .bind(now, now)
    .all<{ id: string }>();
  if (results.length)
    await env.JOBS.sendBatch(results.map((x) => ({ body: { id: x.id } })));
  await env.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(now).run();
  await env.DB.prepare(
    "DELETE FROM jobs WHERE state IN ('done','cancelled') AND updated<?",
  )
    .bind(now - 30 * 86400_000)
    .run();
}
async function finish(env: Env, job: Job, state: string, result: string) {
  await env.DB.prepare(
    "UPDATE jobs SET state=?,result=?,lease=0,updated=? WHERE id=?",
  )
    .bind(state, result, Date.now(), job.id)
    .run();
}
async function processJob(env: Env, job: Job) {
  const deadline = job.started + 8 * 60_000;
  if (Date.now() >= deadline)
    throw new Error("Execution deadline exceeded; retry from setup");
  if (job.kind === "discover") {
    const installation = record(
      await github(
        appJWT(env),
        deadline,
      )(`/app/installations/${job.installation}`),
    );
    if (installation.suspended_at) throw new ApiError(403, false);
    const account = record(installation.account);
    if (
      typeof account.login !== "string" ||
      !allowed(env, `${account.login}/_`)
    ) {
      await finish(env, job, "cancelled", "Account outside rollout");
      return;
    }
    const api = github(
      await installationToken(env, job.installation, undefined, deadline),
      deadline,
    );
    // One page per queue execution, so even large installations stay bounded.
    const page = record(
      await api(`/installation/repositories?per_page=100&page=${job.page}`),
    );
    if (!Array.isArray(page.repositories))
      throw new Error("Invalid repository list");
    for (const item of page.repositories) {
      const repo = record(item);
      if (repo.archived === true) continue;
      await putJob(env, {
        id: `${job.id}:repo:${positive(repo.id)}`,
        kind: "initialize",
        installation: job.installation,
        repository: positive(repo.id),
        full_name: repositoryName(repo.full_name),
      });
    }
    if (page.repositories.length === 100) {
      await env.DB.prepare(
        "UPDATE jobs SET page=page+1,state='pending',lease=0,due=?,updated=? WHERE id=?",
      )
        .bind(Date.now(), Date.now(), job.id)
        .run();
    } else
      await finish(env, job, "done", "Repositories queued for initialization");
    return;
  }
  if (!job.repository) throw new Error("Missing repository");
  // Repository-scoped token issuance rechecks current installation membership.
  const api = github(
    await installationToken(env, job.installation, job.repository, deadline),
    deadline,
  );
  const repo = record(await api(`/repositories/${job.repository}`));
  const fullName = repositoryName(repo.full_name);
  if (repo.archived === true || !allowed(env, fullName)) {
    await finish(
      env,
      job,
      "cancelled",
      "Repository unavailable or outside rollout",
    );
    return;
  }
  await env.DB.prepare("UPDATE jobs SET full_name=? WHERE id=?")
    .bind(fullName, job.id)
    .run();
  if (job.kind === "initialize") {
    if (!(job.page > 1)) await initializeLabels(api, fullName);
    // Pull-request backfill is paused. Only the first two pages of open issues
    // are queued. Listing /pulls would enqueue jobs that label, comment, read
    // the author, and send email. Restore the commented continuation to queue
    // two pull-request pages again.
    const page = job.page;
    for (;;) {
      if (page < 1 || page > 2) break;
      const list = await api(
        `/repos/${fullName}/issues?state=open&per_page=100&page=${page}`,
      );
      // const apiPage = page - 2;
      // const list = await api(
      //   `/repos/${fullName}/pulls?state=open&per_page=100&page=${apiPage}`,
      // );
      if (!Array.isArray(list)) throw new Error("Invalid issue list");
      for (const value of list) {
        const issue = record(value);
        if (issue.state !== "open") continue;
        // The issues API mixes in pull requests. Skip them while PR review is paused.
        if (issue.pull_request) continue;
        const number = positive(issue.number);
        await putJob(env, {
          id: `open-${job.installation}-${job.repository}-${number}`,
          installation: job.installation,
          kind: "label",
          repository: job.repository,
          full_name: fullName,
          pr: number,
        });
      }
      if (list.length === 100 && page < 2) {
        await env.DB.prepare(
          "UPDATE jobs SET page=?,state='pending',lease=0,due=?,updated=? WHERE id=?",
        )
          .bind(page + 1, Date.now(), Date.now(), job.id)
          .run();
        return;
      }
      // Restoring two pull-request pages needs `let page` and:
      // if (!issues) break;
      // page = 3;
      break;
    }
    // await finish(env, job, "done", "Open issues and pull requests queued");
    await finish(env, job, "done", "Open issues queued");
    return;
  }
  const pr = record(await api(`/repos/${fullName}/issues/${job.pr}`));
  if (pr.state !== "open") {
    await finish(env, job, "cancelled", "Issue or pull request closed");
    return;
  }
  // Already-queued pull requests stop here, before the author is read.
  // Do not score pr.user, initialize or sync a label, post a comment, or
  // enqueue email. New pull_request.opened events no longer create these jobs.
  if (pr.pull_request) {
    await finish(env, job, "cancelled", "Pull request review paused");
    return;
  }
  await initializeLabels(api, fullName);
  if (rescoreGeneration(job.id) > 0) {
    const applied = await labels(
      api,
      `/repos/${fullName}/issues/${positive(job.pr)}/labels`,
    );
    if (!applied.has(LABELS[4])) {
      await finish(env, job, "cancelled", "No-score label no longer present");
      return;
    }
  }
  const user = record(pr.user);
  if (
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(user.login)
  )
    throw new Error("Invalid author login");
  let transient = false;
  if (job.score === null) {
    let score: unknown = null;
    if (Date.now() < job.started + 4 * 60_000) {
      try {
        const response = record(
          await jsonRequest(
            `https://ghfind.com/api/score/${encodeURIComponent(user.login)}`,
            { headers: { Accept: "application/json" } },
            Math.min(deadline, job.started + 4 * 60_000),
            env.SCORE.fetch.bind(env.SCORE),
          ),
        );
        score = response.final_score;
        job.score_context = JSON.stringify(scoreContext(response));
      } catch (error) {
        const retryable = error instanceof ApiError && error.retry;
        if (
          retryable &&
          job.attempts < 7 &&
          Date.now() + Math.max(5000, error.delay) < job.started + 4 * 60_000
        )
          throw error;
        // A non-retryable response, such as a missing account, is final.
        transient = retryable || !(error instanceof ApiError);
      }
    } else transient = true;
    const usable =
      typeof score === "number" &&
      Number.isFinite(score) &&
      score >= 0 &&
      score <= 100;
    if (usable) transient = false;
    else
      job.score_context = JSON.stringify({
        score: null,
        percentile: null,
        rescore: transient,
      });
    // Persist before the first label write: a replay cannot oscillate on score changes.
    job.score = JSON.stringify(usable ? score : null);
    await env.DB.prepare("UPDATE jobs SET score=?,score_context=? WHERE id=?")
      .bind(job.score, job.score_context ?? null, job.id)
      .run();
  } else if (job.score_context) {
    try {
      transient = record(JSON.parse(job.score_context)).rescore === true;
    } catch {
      transient = false;
    }
  }
  const label = scoreToLabel(JSON.parse(job.score));
  const issueNumber = positive(job.pr);
  await syncLabel(api, fullName, issueNumber, label);
  // Issue comments are paused. Only the label is written. A bot comment makes
  // GitHub send its own thread notification, separate from the score email.
  // To post again, import syncComment from ./review and restore the calls below.
  // const userId = Number(user.id);
  // const allowNew =
  //   Number.isInteger(userId) && userId > 0
  //     ? await reserveIssueComment(
  //         env,
  //         job.installation,
  //         positive(job.repository),
  //         userId,
  //         label === LABELS[4],
  //       )
  //     : true;
  // await syncComment(
  //   api,
  //   fullName,
  //   issueNumber,
  //   user.login,
  //   JSON.parse(job.score),
  //   env.APP_SLUG,
  //   env.EMAIL_ENABLED === "true",
  //   allowNew,
  // );
  if (env.EMAIL_ENABLED === "true")
    await enqueueAuthorEmail(
      env,
      positive(user.id),
      {
        login: user.login,
        repository: fullName,
        number: positive(job.pr),
        installation: job.installation,
        repositoryId: job.repository,
        // Pull requests return before this call, so the email is issue-only.
        // kind: pr.pull_request ? "PR" : "issue",
        kind: "issue",
        ...(job.score_context
          ? JSON.parse(job.score_context)
          : { score: JSON.parse(job.score), percentile: null }),
      },
      job.repository,
      api,
    );
  if (label === LABELS[4] && transient) await scheduleRescore(env, job);
  await finish(env, job, "done", label);
}
const NOSCORE_COMMENT_LIMIT = 3;
export async function reserveIssueComment(
  env: Env,
  installation: number,
  repository: number,
  userId: number,
  noScore: boolean,
): Promise<boolean> {
  if (noScore) {
    const slot = await env.DB.prepare(
      `INSERT INTO noscore_comment_budget(installation, repository, used) VALUES(?,?,1)
       ON CONFLICT(installation, repository) DO UPDATE SET used=used+1 WHERE used<${NOSCORE_COMMENT_LIMIT}
       RETURNING used`,
    )
      .bind(installation, repository)
      .first();
    if (!slot) return false;
  }
  const claimed = await env.DB.prepare(
    `INSERT INTO author_comment_once(installation, repository, user_id, created)
     VALUES(?,?,?,?) ON CONFLICT(installation, repository, user_id) DO NOTHING RETURNING user_id`,
  )
    .bind(installation, repository, userId, Date.now())
    .first();
  if (claimed) return true;
  if (noScore)
    await env.DB.prepare(
      "UPDATE noscore_comment_budget SET used=used-1 WHERE installation=? AND repository=? AND used>0",
    )
      .bind(installation, repository)
      .run();
  return false;
}
async function deferForQuota(env: Env, job: Job, delay: number) {
  const due =
    Date.now() + Math.min(Math.max(delay, 60_000), 65 * 60_000);
  await env.DB.prepare(
    `UPDATE jobs
     SET state='pending', due=?, lease=0, started=0, attempts=0, result=?, updated=?
     WHERE installation=? AND (id=? OR state='pending')`,
  )
    .bind(
      due,
      "Waiting for the GitHub App hourly quota to reset",
      Date.now(),
      job.installation,
      job.id,
    )
    .run();
}
export async function runJob(env: Env, id: string) {
  if (env.ENABLED !== "true") return;
  const now = Date.now();
  // Lease outlives the eight-minute budget. Queue concurrency can run many
  // issues at once; a second job for the same issue waits instead of racing.
  const job = await env.DB.prepare(
    `UPDATE jobs SET state='running',lease=?,updated=?,started=CASE WHEN started=0 THEN ? ELSE started END
     WHERE id=? AND ((state='pending' AND due<=?) OR (state='running' AND lease<?))
       AND NOT EXISTS (
         SELECT 1 FROM jobs AS other
         WHERE other.id != jobs.id
           AND other.installation = jobs.installation
           AND other.repository = jobs.repository
           AND other.pr = jobs.pr
           AND other.pr IS NOT NULL
           AND other.state = 'running'
           AND other.lease > ?
       )
     RETURNING *`,
  )
    .bind(now + 10 * 60_000, now, now, id, now, now, now)
    .first<Job>();
  if (!job) {
    await env.DB.prepare(
      `UPDATE jobs SET due=?,updated=?
       WHERE id=? AND state='pending'
         AND EXISTS (
           SELECT 1 FROM jobs AS other
           WHERE other.id != jobs.id
             AND other.installation = jobs.installation
             AND other.repository = jobs.repository
             AND other.pr = jobs.pr
             AND other.pr IS NOT NULL
             AND other.state = 'running'
             AND other.lease > ?
         )`,
    )
      .bind(now + 15_000, now, id, now)
      .run();
    return;
  }
  try {
    await processJob(env, job);
  } catch (error) {
    if (error instanceof ApiError && error.quota) {
      await deferForQuota(env, job, error.delay);
      return;
    }
    if (
      error instanceof ApiError &&
      [401, 403, 404, 422].includes(error.status) &&
      !error.retry
    ) {
      await finish(
        env,
        job,
        "failed",
        `GitHub access/configuration error (${error.status}); check installation permissions and repository access`,
      );
      return;
    }
    const delay = Math.max(
      Math.min(5000 * 2 ** job.attempts, 20000),
      error instanceof ApiError ? error.delay : 0,
    );
    if (
      error instanceof ApiError &&
      error.retry &&
      job.attempts < 7 &&
      Date.now() + delay < job.started + 8 * 60_000
    ) {
      await env.DB.prepare(
        "UPDATE jobs SET state='pending',attempts=attempts+1,due=?,lease=0,result=?,updated=? WHERE id=?",
      )
        .bind(Date.now() + delay, error.message, Date.now(), job.id)
        .run();
      await env.JOBS.send(
        { id: job.id },
        { delaySeconds: Math.ceil(delay / 1000) },
      );
    } else {
      const result =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Job failed";
      // Do not include tokens, payloads, author data or response bodies in DLQ/logs.
      await env.DEAD.send({ id: job.id });
      await finish(env, job, "failed", result);
    }
  }
}
