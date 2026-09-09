// External provider fixtures only. No application session or projection is synthesized here.
const PROJECT_ANALYSIS_SCHEMA_VERSION = "ghfind.project-analysis.v3";
const evidence = {
  schema_version: PROJECT_ANALYSIS_SCHEMA_VERSION,
  analysis_id: "analysis-1",
  repo_key: "owner/useful-tool",
  resolved_commit_sha: "a".repeat(40),
  entries: [
    {
      id: "readme-contract",
      kind: "source",
      summary: "README defines one-command conversion.",
      outcome: "pass",
      path: "README.md",
    },
  ],
};
const analysis = {
  schema_version: PROJECT_ANALYSIS_SCHEMA_VERSION,
  analysis_id: "analysis-1",
  repository: {
    repo_key: "owner/useful-tool",
    canonical_url: "https://github.com/owner/useful-tool",
    requested_ref: null,
    resolved_commit_sha: "a".repeat(40),
  },
  rubric_version: "project-value-v1",
  agent_version: "project-evaluator-v3",
  skill_version: "ghfind-project-evaluator-v4",
  project: {
    name: "useful-tool",
    summary: "Converts one format into another.",
    target_users: ["developers"],
    pain_statement: "Manual conversion is repetitive.",
    project_type: "micro_tool",
    lifecycle: "feature_complete",
    product_tags: [
      {
        namespace: "use_case",
        slug: "one-command-conversion",
        labels: { zh: "一键转换", en: "One-command conversion" },
        evidence_ids: ["readme-contract"],
      },
      {
        namespace: "artifact",
        slug: "developer-cli",
        labels: { zh: "开发者 CLI", en: "Developer CLI" },
        evidence_ids: ["readme-contract"],
      },
      {
        namespace: "audience",
        slug: "automation-friendly",
        labels: { zh: "自动化友好", en: "Automation-friendly" },
        evidence_ids: ["readme-contract"],
      },
    ],
  },
  scores: {
    pain: {
      score: 21,
      max_score: 25,
      rationale: "The problem is frequent and concrete.",
      evidence_ids: ["readme-contract"],
    },
    effectiveness: {
      score: 27,
      max_score: 30,
      rationale: "The command produces the promised result.",
      evidence_ids: ["readme-contract"],
    },
    experience: {
      score: 25,
      max_score: 30,
      rationale: "The primary command is documented.",
      evidence_ids: ["readme-contract"],
    },
    value_density: {
      score: 14,
      max_score: 15,
      rationale: "Small surface with clear value.",
      evidence_ids: ["readme-contract"],
    },
    product_score: 87,
  },
  confidence: 74,
  verification_level: "source_inspected",
  unknowns: ["Runtime execution was not allowed."],
  risks: [],
  community_strength: {
    score: 38,
    rationale: "A small but credible contributor group supports the project.",
    evidence_ids: ["readme-contract"],
  },
  exposure: {
    band: "low",
    stars: 42,
    dependents: null,
    downloads: null,
    rationale: "Low stars for a complete tool.",
    evidence_ids: ["readme-contract"],
  },
  analyzed_at: "2026-07-15T00:00:00.000Z",
};
export function artifacts(analysisId, repoKey) {
  const result = structuredClone(analysis);
  result.analysis_id = analysisId;
  result.repository.repo_key = repoKey;
  result.repository.canonical_url = `https://github.com/${repoKey}`;
  result.analyzed_at = new Date().toISOString();
  const proof = { ...structuredClone(evidence), analysis_id: analysisId, repo_key: repoKey };
  return { analysis: JSON.stringify(result), evidence: JSON.stringify(proof), report: "# Local provider fixture assessment\n\nExternal evaluator fixture; application finalization is real." };
}
export function installProviders() {
  const original = globalThis.fetch;
  const runs = new Map();
  const counts = { oauthTokenExchange: 0, oauthProfile: 0, assessmentCreate: 0, artifactDownloads: 0, unexpectedExternal: 0 };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      if (request.method !== "POST" || body.get("client_id") !== "local-e2e-oauth" || body.get("client_secret") !== process.env.AUTH_GITHUB_SECRET || body.get("redirect_uri") !== `${process.env.PUBLIC_SITE_URL}/api/auth/callback/github` || !["local-ordinary", "local-governor"].includes(body.get("code"))) return Response.json({ error: "invalid_fixture_oauth_request" }, { status: 400 });
      counts.oauthTokenExchange++;
      return Response.json({ access_token: `fixture-${body.get("code")}` });
    }
    if (url.origin === "https://api.github.com" && url.pathname === "/user") {
      const token = request.headers.get("authorization");
      const id = token === "Bearer fixture-local-ordinary" ? 4242 : token === "Bearer fixture-local-governor" ? 4243 : 0;
      if (!id) return Response.json({ error: "invalid_fixture_token" }, { status: 401 });
      counts.oauthProfile++;
      return Response.json({ id, login: id === 4242 ? "feed-e2e-user" : "feed-e2e-governor", name: "Local E2E fixture" });
    }
    if (url.origin === "https://feed-e2e-provider.invalid") {
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (path === "/agents/local-e2e-agent/threads" && request.method === "POST") {
        const body = await request.json();
        const prompt = body.input?.content?.[0]?.text ?? "";
        const repo = /^repository_url: https:\/\/github.com\/([a-z0-9-]+\/[a-z0-9-]+)$/m.exec(prompt)?.[1];
        if (!repo || !body.client_external_ref) throw new Error("invalid_fixture_assessment_request");
        runs.set(body.client_external_ref, { repo, files: artifacts(body.client_external_ref, repo) });
        counts.assessmentCreate++;
        return Response.json(thread(body.client_external_ref));
      }
      const match = /^\/threads\/([^/]+)(?:\/(events|files))?$/.exec(path);
      if (match && runs.has(match[1])) {
        if (!match[2]) return Response.json(thread(match[1]));
        if (match[2] === "events") return Response.json({ events: [], truncated: false });
        const run = runs.get(match[1]);
        return Response.json({ files: Object.entries(run.files).map(([kind, content]) => ({ id: `${match[1]}:${kind}`, name: `${({ analysis: "project-analysis", evidence: "runtime-evidence", report: "project-report" })[kind]}-${match[1]}.${kind === "report" ? "md" : "json"}`, kind: "artifact", committed: true, size: Buffer.byteLength(content), mimeType: kind === "report" ? "text/markdown" : "application/json" })) });
      }
      const file = /^\/files\/([^:]+):(analysis|evidence|report)\/content$/.exec(path);
      if (file && runs.has(file[1])) { counts.artifactDownloads++; return new Response(runs.get(file[1]).files[file[2]]); }
      throw new Error("unexpected_fixture_provider_request");
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) { counts.unexpectedExternal++; throw new Error("external_network_disabled_in_local_e2e"); }
    return original(input, init);
  };
  function thread(id) {
    const now = new Date().toISOString();
    return { thread: { id, agent_id: "local-e2e-agent", kind: "cattle", status: "IDLE", client_external_ref: id }, run: { id: `run-${id}`, status: "completed", createdAt: now, startedAt: now, completedAt: now, updatedAt: now, trigger: "user_prompt" } };
  }
  return counts;
}
