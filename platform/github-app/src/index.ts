import { sendAuthorEmails } from "./author-email";
import { positive, readText, record, repositoryName } from "./github";
import { admitMention, allowed, dispatch, putJob, runJob } from "./jobs";
import { ui } from "./ui";

export async function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (x) =>
    parseInt(x, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(body),
  );
}
export async function webhook(request: Request, env: Env): Promise<Response> {
  if (env.ENABLED !== "true")
    return new Response("Bot paused", { status: 503 });
  let body: string;
  try {
    body = await readText(request, AbortSignal.timeout(8000), 8 * 1024 * 1024);
  } catch {
    return new Response("Payload unavailable or too large", { status: 413 });
  }
  if (
    !(await verifySignature(
      body,
      request.headers.get("x-hub-signature-256"),
      env.WEBHOOK_SECRET,
    ))
  )
    return new Response("Invalid signature", { status: 401 });
  const event = request.headers.get("x-github-event");
  if (event === "ping") return new Response("pong");
  const delivery = request.headers.get("x-github-delivery");
  if (!delivery || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery))
    return new Response("Invalid delivery ID", { status: 400 });
  try {
    const payload = record(JSON.parse(body));
    if (
      ![
        "pull_request",
        "issues",
        "issue_comment",
        "installation",
        "installation_repositories",
      ].includes(event ?? "")
    )
      return new Response("Ignored");
    const install = record(payload.installation);
    const installation = positive(install.id);
    if (install.app_id !== undefined && install.app_id !== Number(env.APP_ID))
      return new Response("Wrong app", { status: 403 });
    const account = record(
      event === "pull_request" ||
        event === "issues" ||
        event === "issue_comment"
        ? record(payload.repository).owner
        : install.account,
    );
    if (
      typeof account.login !== "string" ||
      !allowed(env, `${account.login}/_`)
    )
      return new Response("Outside rollout");
    if (
      (event === "pull_request" || event === "issues") &&
      payload.action === "opened"
    ) {
      if (event === "issues" && record(payload.issue).pull_request)
        return new Response("Ignored PR issue event");
      const repo = record(payload.repository);
      const fullName = repositoryName(repo.full_name);
      if (!allowed(env, fullName)) return new Response("Outside rollout");
      await putJob(env, {
        id: delivery,
        installation,
        kind: "label",
        repository: positive(repo.id),
        full_name: fullName,
        pr: positive(
          event === "issues" ? record(payload.issue).number : payload.number,
        ),
      });
    } else if (event === "issue_comment") {
      await admitMention(env, delivery, payload);
    } else if (
      (event === "installation" &&
        ["created", "unsuspend", "new_permissions_accepted"].includes(
          String(payload.action),
        )) ||
      (event === "installation_repositories" && payload.action === "added")
    ) {
      await putJob(env, { id: delivery, installation, kind: "discover" });
    } else if (
      event === "installation" &&
      ["deleted", "suspend"].includes(String(payload.action))
    ) {
      await env.DB.prepare(
        "UPDATE jobs SET state='cancelled',lease=0,result='Installation removed or suspended',updated=? WHERE installation=? AND state='pending'",
      )
        .bind(Date.now(), installation)
        .run();
    } else if (
      event === "installation_repositories" &&
      payload.action === "removed"
    ) {
      if (!Array.isArray(payload.repositories_removed))
        throw new Error("Invalid removed repositories");
      for (const value of payload.repositories_removed)
        await env.DB.prepare(
          "UPDATE jobs SET state='cancelled',result='Repository removed',updated=? WHERE installation=? AND repository=? AND state='pending'",
        )
          .bind(Date.now(), installation, positive(record(value).id))
          .run();
    }
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && /Invalid|Missing/.test(error.message))
    )
      return new Response("Invalid event", { status: 400 });
    throw error;
  }
  // Durable SQL admission succeeds first. Cron recovers if the queue is unavailable.
  await dispatch(env);
  return new Response("Accepted", { status: 202 });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/webhook" && request.method === "POST")
        return await webhook(request, env);
      if (path === "/health" && request.method === "GET")
        return Response.json({
          service: "ghfind-github-app",
          enabled: env.ENABLED === "true",
        });
      if (path === "/avatar.png") return env.ASSETS.fetch(request);
      return await ui(request, env);
    } catch {
      return new Response("Temporarily unavailable", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
  },
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
    for (const message of batch.messages) {
      try {
        await runJob(env, message.body.id);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await dispatch(env);
    await sendAuthorEmails(env);
  },
} satisfies ExportedHandler<Env, { id: string }>;
