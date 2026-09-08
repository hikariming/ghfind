import { BridgeError, schemas, type Input, type Operation } from "./contract";
import { FeedCommands } from "./commands";
import { executorSchemas, type ExecutorOperation } from "./executor-contract";
import { FeedJobs } from "./jobs";
import { FeedCleanup, cleanupSchemas } from "./cleanup";
import { FeedOperator, operatorSchemas } from "./operator";
import { handleArchive } from "./archive-http";
import { FeedDelivery, deliverySchemas } from "./delivery";

const MAX_BODY = 128 * 1024;
async function body(request: Request, operation: string): Promise<unknown> {
  const limit =
    operation === "archive"
      ? 6 * 1024 * 1024
      : operation === "sessions.put" || operation === "requests.save"
        ? 2 * 1024 * 1024
        : MAX_BODY;
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new BridgeError(415, "unsupported_media_type");
  if (Number(request.headers.get("content-length")) > limit)
    throw new BridgeError(413, "request_too_large");
  if (!request.body) throw new BridgeError(400, "invalid_request");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BridgeError(413, "request_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new BridgeError(400, "invalid_request");
  }
}
async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const provided = request.headers.get("authorization") ?? "";
  // Hash both inputs before constant-time comparison, including unequal lengths.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`Bearer ${secret}`),
    ),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
export async function handleOperation(
  operation: Operation,
  raw: unknown,
  env: Env,
): Promise<object> {
  const store = new FeedCommands(env.FEED_DB);
  const parse = <K extends Operation>(op: K): Input<K> => {
    const result = schemas[op].safeParse(raw);
    if (!result.success) throw new BridgeError(400, "invalid_request");
    return result.data as Input<K>;
  };
  switch (operation) {
    case "health": {
      parse(operation);
      const [control] = await store.rows<{
        schema_version: number;
        writer_epoch: number;
        writes_enabled: number;
      }>(
        "SELECT schema_version,writer_epoch,writes_enabled FROM feed_runtime_control WHERE id=1",
      );
      await env.FEED_ARCHIVE.head("health/capability-v1");
      const [tables] = await store.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('feed_runtime_sessions','feed_runtime_requests','feed_runtime_events','feed_execution_jobs','feed_project_source_versions','feed_user_tag_proposals','feed_replay_deliveries','feed_delivery_heads','feed_delivery_terminals')",
      );
      const [compatibility] = await store.rows<{ compatible: number }>(
        "SELECT min_reader_contract<=1 AND max_reader_contract>=1 AND min_writer_contract<=1 AND max_writer_contract>=1 AS compatible FROM feed_schema_compatibility WHERE id=1",
      );
      return {
        ready:
          control?.schema_version >= 7 &&
          tables.count === 9 &&
          compatibility?.compatible === 1,
        contractVersion: "1",
        writerEpoch: control?.writer_epoch ?? 0,
        writesEnabled: control?.writes_enabled === 1,
      };
    }
    case "taxonomy.list":
      parse(operation);
      return store.taxonomy();
    case "taxonomy.propose":
      return store.propose(parse(operation));
    case "users.ensure":
      return store.ensure(parse(operation));
    case "users.get":
      return { user: await store.user(parse(operation).githubId) };
    case "preferences.replace":
      return store.preferences(parse(operation));
    case "candidates.load":
      return store.candidates(parse(operation));
    case "projects.available":
      return store.available(parse(operation));
    case "requests.save":
      return store.saveRequest(parse(operation));
    case "state.set":
      return store.state(parse(operation));
    case "events.append":
      return store.events(parse(operation));
    case "profile.delete":
      return store.deleteProfile(parse(operation));
    case "profile.deletion.get":
      return store.deletion(parse(operation));
    case "sessions.put":
      return store.putSession(parse(operation));
    case "sessions.get":
      return store.getSession(parse(operation));
    case "sessions.delete":
      return store.deleteSession(parse(operation));
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = { "Cache-Control": "no-store", "X-Feed-Contract": "1" };
    try {
      const url = new URL(request.url),
        archive = url.pathname.startsWith("/internal/feed/archive/v1/"),
        cleanup = url.pathname.startsWith("/internal/feed/cleanup/v1/"),
        operator = url.pathname.startsWith("/internal/feed/admin/v1/"),
        delivery = url.pathname.startsWith("/internal/feed/delivery/v1/");
      const secret = delivery
        ? env.FEED_DELIVERY_SECRET
        : cleanup || archive
          ? env.FEED_EXECUTOR_SECRET
          : operator
            ? env.FEED_OPERATOR_SECRET
            : env.FEED_BRIDGE_SECRET;
      if (!(await authorized(request, secret)))
        throw new BridgeError(401, "unauthorized");
      if (request.method !== "POST")
        throw new BridgeError(405, "method_not_allowed");
      if (request.headers.get("x-feed-contract") !== "1")
        throw new BridgeError(409, "contract_version_changed");
      if (url.search) throw new BridgeError(404, "operation_not_found");
      if (archive) {
        return Response.json(
          await handleArchive(
            url.pathname.slice("/internal/feed/archive/v1/".length),
            await body(request, "archive"),
            env,
          ),
          { headers },
        );
      }
      if (cleanup || operator || delivery) {
        const operation = url.pathname.split("/").at(-1)!;
        if (
          url.pathname !==
          `/internal/feed/${cleanup ? "cleanup" : delivery ? "delivery" : "admin"}/v1/${operation}`
        )
          throw new BridgeError(404, "operation_not_found");
        const raw = await body(request, operation);
        return Response.json(
          delivery
            ? await handleDelivery(operation, raw, env)
            : cleanup
              ? await handleCleanup(operation, raw, env)
              : await handleOperator(operation, raw, env),
          { headers },
        );
      }
      const operation = url.pathname.replace(/^\/internal\/feed\/v1\//, "");
      if (
        url.search ||
        !url.pathname.startsWith("/internal/feed/v1/") ||
        (!Object.hasOwn(schemas, operation) &&
          !Object.hasOwn(executorSchemas, operation))
      )
        throw new BridgeError(404, "operation_not_found");
      const raw = await body(request, operation);
      return Response.json(
        Object.hasOwn(executorSchemas, operation)
          ? await handleExecutor(operation as ExecutorOperation, raw, env)
          : await handleOperation(operation as Operation, raw, env),
        { headers },
      );
    } catch (error) {
      if (error instanceof BridgeError)
        return Response.json(
          { error: error.code },
          { status: error.status, headers },
        );
      // Never log body, identities, SQL bind values, tokens, or exception text.
      console.error(
        JSON.stringify({
          component: "feed-adapter",
          event: "capability_failed",
        }),
      );
      return Response.json(
        { error: "feed_unavailable" },
        { status: 503, headers },
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function handleExecutor(
  operation: ExecutorOperation,
  raw: unknown,
  env: Env,
) {
  const store = new FeedJobs(env.FEED_DB);
  switch (operation) {
    case "jobs.claim": {
      const input = executorSchemas[operation].safeParse(raw);
      if (!input.success) throw new BridgeError(400, "invalid_request");
      return store.claim(input.data);
    }
    case "jobs.complete":
    case "jobs.fail": {
      const input = executorSchemas[operation].safeParse(raw);
      if (!input.success) throw new BridgeError(400, "invalid_request");
      return store.finish(input.data, operation === "jobs.fail");
    }
    case "projection.apply": {
      const input = executorSchemas[operation].safeParse(raw);
      if (!input.success) throw new BridgeError(400, "invalid_request");
      return store.apply(input.data);
    }
  }
}

async function handleCleanup(operation: string, raw: unknown, env: Env) {
  const store = new FeedCleanup(env);
  switch (operation) {
    case "pending": {
      const parsed = cleanupSchemas.pending.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.pending();
    }
    case "claim": {
      const parsed = cleanupSchemas.claim.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.claim(parsed.data);
    }
    case "step":
    case "release": {
      const parsed = cleanupSchemas[operation].safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return operation === "step"
        ? store.step(parsed.data)
        : store.finish(parsed.data);
    }
    case "fail": {
      const parsed = cleanupSchemas.fail.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.finish(parsed.data, parsed.data.errorCode);
    }
    default:
      throw new BridgeError(404, "operation_not_found");
  }
}
async function handleOperator(operation: string, raw: unknown, env: Env) {
  const store = new FeedOperator(env.FEED_DB);
  switch (operation) {
    case "status": {
      const parsed = operatorSchemas.status.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.status(parsed.data);
    }
    case "replay": {
      const parsed = operatorSchemas.replay.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.replay(parsed.data);
    }
    default:
      throw new BridgeError(404, "operation_not_found");
  }
}

async function handleDelivery(operation: string, raw: unknown, env: Env) {
  const store = new FeedDelivery(env.FEED_DB);
  switch (operation) {
    case "pending": {
      const parsed = deliverySchemas.pending.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.pending();
    }
    case "claim": {
      const parsed = deliverySchemas.claim.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.claimDelivery(parsed.data);
    }
    case "finish": {
      const parsed = deliverySchemas.finish.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.finishDelivery(parsed.data);
    }
    case "terminal": {
      const parsed = deliverySchemas.terminal.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.terminal(parsed.data);
    }
    default:
      throw new BridgeError(404, "operation_not_found");
  }
}
