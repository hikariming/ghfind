// Run after registering/installing the App. Uses existing gh authentication;
// no personal token is passed to the deployed Worker.
import { execFileSync } from "node:child_process";
const [mode, repository, slug, numberInput = "1"] = process.argv.slice(2);
if (
  !["prepare", "open", "verify"].includes(mode) ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")
)
  throw new Error(
    "Usage: node scripts/e2e.mjs prepare|open|verify owner/test-repository [app-slug] [issue-or-pr-number]",
  );
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const api = (path, ...args) => JSON.parse(gh("api", path, ...args) || "null");
const owner = repository.split("/")[0];
if (gh("api", "user", "--jq", ".login").toLowerCase() !== owner.toLowerCase())
  throw new Error("Use a disposable repository in the signed-in account");
if (mode === "prepare") {
  gh(
    "repo",
    "create",
    repository,
    "--private",
    "--description",
    "Disposable ghfind GitHub App end-to-end verification",
  );
  api(
    `repos/${repository}/contents/README.md`,
    "--method",
    "PUT",
    "-f",
    "message=Initialize disposable bot E2E repository",
    "-f",
    `content=${Buffer.from("# ghfind bot E2E\n").toString("base64")}`,
  );
  console.log(`Install the App ONLY on ${repository}, then run open.`);
} else if (mode === "open") {
  const labels = api(`repos/${repository}/labels?per_page=100`).map(
    (x) => x.name,
  );
  const expected = ["low", "medium", "high", "top", "no-score"].map(
    (x) => `review: ${x}`,
  );
  if (!expected.every((x) => labels.includes(x)))
    throw new Error("Installation has not initialized all five labels");
  const main = api(`repos/${repository}/git/ref/heads/main`);
  api(
    `repos/${repository}/git/refs`,
    "--method",
    "POST",
    "-f",
    "ref=refs/heads/codex/bot-e2e",
    "-f",
    `sha=${main.object.sha}`,
  );
  api(
    `repos/${repository}/contents/probe.txt`,
    "--method",
    "PUT",
    "-f",
    "branch=codex/bot-e2e",
    "-f",
    "message=Exercise opened draft PR webhook",
    "-f",
    `content=${Buffer.from("No workflow or executable code is required.\n").toString("base64")}`,
  );
  console.log(
    gh(
      "pr",
      "create",
      "--repo",
      repository,
      "--head",
      "codex/bot-e2e",
      "--base",
      "main",
      "--draft",
      "--title",
      "E2E: independent ghfind bot identity",
      "--body",
      "Disposable draft PR for verifying automatic review-level labeling and the GitHub App actor.",
    ),
  );
} else {
  if (!/^[a-z0-9-]+$/.test(slug ?? ""))
    throw new Error("App slug required for verify");
  if (!/^[1-9][0-9]*$/.test(numberInput))
    throw new Error("Invalid issue/PR number");
  const pr = api(`repos/${repository}/issues/${numberInput}`);
  const events = api(
    `repos/${repository}/issues/${numberInput}/events?per_page=100`,
  );
  const labeled = events.filter(
    (x) =>
      x.event === "labeled" && x.label?.name?.startsWith("review: "),
  );
  if (labeled.length !== 1)
    throw new Error(
      `Expected exactly one labeling event, found ${labeled.length}`,
    );
  const event = labeled[0];
  if (event.actor?.login !== `${slug}[bot]` || event.actor.type !== "Bot")
    throw new Error("Wrong actor: independent App identity not verified");
  const live = await fetch(
    `https://ghfind.com/api/score/${encodeURIComponent(pr.user.login)}`,
  ).then((x) => x.json());
  const score = live.final_score;
  const level =
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100
      ? "no-score"
      : score < 40
        ? "low"
        : score < 70
          ? "medium"
          : score < 90
            ? "high"
            : "top";
  if (event.label.name !== `review: ${level}`)
    throw new Error(
      "Label does not match current live score; inspect score at processing time",
    );
  const comments = api(
    `repos/${repository}/issues/${numberInput}/comments?per_page=100`,
  ).filter(
    (x) =>
      x.user?.login === `${slug}[bot]` &&
      x.user.type === "Bot" &&
      x.body?.startsWith("<!-- ghfind-review:author-score:v1 -->"),
  );
  if (comments.length !== 1)
    throw new Error(
      `Expected exactly one score comment, got ${comments.length}`,
    );
  const body = comments[0].body;
  const ranges = {
    low: "0 ≤ score < 40",
    medium: "40 ≤ score < 70",
    high: "70 ≤ score < 90",
    top: "90 ≤ score ≤ 100",
    "no-score": "No score",
  };
  if (
    !body.includes(
      `https://ghfind.com/en/u/${encodeURIComponent(pr.user.login)}`,
    ) ||
    !body.includes(ranges[level]) ||
    !body.includes(level === "no-score" ? "No score" : `${score} / 100`)
  )
    throw new Error("Comment profile, score or interval does not match");
  console.log(
    JSON.stringify(
      {
        repository,
        subject: pr.html_url,
        kind: pr.pull_request ? "pull_request" : "issue",
        comment: comments[0].html_url,
        commentCount: comments.length,
        score,
        label: event.label.name,
        actor: event.actor.login,
        avatar: event.actor.avatar_url,
        labelEvents: labeled.length,
      },
      null,
      2,
    ),
  );
}
