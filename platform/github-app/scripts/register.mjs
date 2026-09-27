// Maintainer-only manifest handshake. Credentials never enter HTML, logs or Git.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const [originInput, outputInput] = process.argv.slice(2);
if (!originInput || !outputInput)
  throw new Error(
    "Usage: node scripts/register.mjs https://bot.example /absolute/private/credentials.json",
  );
const origin = new URL(originInput);
if (origin.protocol !== "https:" || origin.pathname !== "/")
  throw new Error("Use an HTTPS origin without a path");
const output = resolve(outputInput);
try {
  await access(output);
  throw new Error(
    "Output already exists; refusing to overwrite App credentials",
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const state = randomUUID();
let used = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8789");
  const respond = (status, body) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  };
  if (req.method !== "GET" || req.headers.host !== "127.0.0.1:8789")
    return respond(400, "Invalid request");
  if (url.pathname === `/register/${state}`) {
    const manifest = {
      name: "ghfind Review",
      url: origin.origin,
      description:
        "Automatically initialize review-level labels and label and comment on new issues and PRs using the author’s public ghfind score.",
      public: true,
      hook_attributes: { url: `${origin.origin}/webhook`, active: true },
      redirect_url: "http://127.0.0.1:8789/callback",
      callback_urls: [`${origin.origin}/callback`],
      setup_url: `${origin.origin}/setup`,
      setup_on_update: true,
      default_permissions: { pull_requests: "write", issues: "write" },
      default_events: ["pull_request", "issues", "issue_comment"],
    };
    const encoded = JSON.stringify(manifest)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
    return respond(
      200,
      `<h1>Register ghfind Review</h1><p>Creates one public GitHub App under your currently selected GitHub account. Permissions: issues and pull requests write; metadata read. Webhook: ${origin.origin}/webhook.</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${encoded}"><button>Continue to GitHub registration</button></form>`,
    );
  }
  if (
    url.pathname === "/callback" &&
    url.searchParams.get("state") === state &&
    url.searchParams.get("code") &&
    !used
  ) {
    used = true;
    try {
      const response = await fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get("code"))}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "ghfind-app-registration",
          },
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok)
        throw new Error(`Manifest conversion HTTP ${response.status}`);
      const app = await response.json();
      if (!app.id || !app.pem || !app.webhook_secret || !app.client_secret)
        throw new Error("Incomplete App credentials");
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(
        output,
        JSON.stringify(
          {
            id: app.id,
            slug: app.slug,
            client_id: app.client_id,
            client_secret: app.client_secret,
            pem: app.pem,
            webhook_secret: app.webhook_secret,
          },
          null,
          2,
        ),
        { mode: 0o600, flag: "wx" },
      );
      console.log(
        `Registered App ${app.slug} (${app.id}); credentials saved to private output file.`,
      );
      return respond(
        200,
        "<h1>App registered</h1><p>Credentials saved locally with owner-only permissions. Return to the task to configure the Worker and upload the avatar.</p>",
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Registration failed",
      );
      return respond(500, "Registration failed. Check the local terminal.");
    }
  }
  respond(404, "Not found");
});
server.listen(8789, "127.0.0.1", () =>
  console.log(`Open http://127.0.0.1:8789/register/${state}`),
);
