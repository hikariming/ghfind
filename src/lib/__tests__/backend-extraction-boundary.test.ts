import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const RUNTIME_ROOTS = ["src/app", "src/components"];
const LIGHTWEIGHT_RUNTIME_HELPERS = [
  "src/lib/go-backend.server.ts",
  "src/lib/oauth-config.ts",
  "src/lib/oauth-client.ts",
  "src/lib/me-client.ts",
];

const FORBIDDEN_NEXT_RUNTIME_LIBS = new Set([
  "db",
  "redis",
  "github",
  "llm",
  "scan-core",
  "developers",
  "leaderboard",
  "search",
  "project-discovery",
  "rank",
  "score",
  "score-materialization",
]);

const FORBIDDEN_NEXT_RUNTIME_ENVS = [
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ROAST_CLI_API_KEY",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_SECRET",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_FALLBACK_API_KEY",
  "LLM_FALLBACK_BASE_URL",
  "LLM_FALLBACK_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "TURNSTILE_SECRET_KEY",
  "RABBITMQ_URL",
  "ADMIN_SECRET",
  "RESEND_API_KEY",
];

const ALLOWED_NEXT_RUNTIME_ENVS = new Set([
  "CRON_SECRET",
  "GHFIND_BACKEND_ORIGIN",
  "GHFIND_OAUTH_ENABLED",
  "GHFIND_VERDICT_GATEWAY_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_GA_MEASUREMENT_ID",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "NODE_ENV",
  "PROJECT_ANALYSIS_RECONCILE_SECRET",
  "PUBLIC_SITE_URL",
]);

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(file));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(file)) continue;
    if (/\.d\.ts$/.test(file) || /\.test\.(ts|tsx)$/.test(file)) continue;
    files.push(file);
  }
  return files;
}

function forbiddenRuntimeLib(specifier: string): string | null {
  if (!specifier.startsWith("@/lib/")) return null;
  const lib = specifier.slice("@/lib/".length).split("/")[0];
  return FORBIDDEN_NEXT_RUNTIME_LIBS.has(lib) ? lib : null;
}

function isTypeOnlyImport(importClause: ts.ImportClause | undefined): boolean {
  if (!importClause) return false;
  if (importClause.isTypeOnly) return true;
  if (importClause.name) return false;
  const namedBindings = importClause.namedBindings;
  if (!namedBindings || ts.isNamespaceImport(namedBindings)) return false;
  return namedBindings.elements.length > 0 && namedBindings.elements.every((el) => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
  return node.exportClause.elements.length > 0 && node.exportClause.elements.every((el) => el.isTypeOnly);
}

function stringModuleSpecifier(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

describe("backend extraction boundary", () => {
  it("keeps Next runtime code away from backend business modules", () => {
    const violations: string[] = [];

    for (const file of RUNTIME_ROOTS.flatMap(collectSourceFiles)) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          const specifier = stringModuleSpecifier(statement.moduleSpecifier);
          const forbidden = specifier ? forbiddenRuntimeLib(specifier) : null;
          if (forbidden && !isTypeOnlyImport(statement.importClause)) {
            violations.push(`${path.relative(process.cwd(), file)} imports ${specifier}`);
          }
        }

        if (ts.isExportDeclaration(statement)) {
          const specifier = stringModuleSpecifier(statement.moduleSpecifier);
          const forbidden = specifier ? forbiddenRuntimeLib(specifier) : null;
          if (forbidden && !isTypeOnlyExport(statement)) {
            violations.push(`${path.relative(process.cwd(), file)} exports from ${specifier}`);
          }
        }
      }

      function visit(node: ts.Node): void {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          const specifier = node.arguments[0].text;
          if (forbiddenRuntimeLib(specifier)) {
            violations.push(`${path.relative(process.cwd(), file)} dynamically imports ${specifier}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }

    expect(violations).toEqual([]);
  });

  it("keeps sensitive backend secrets out of Next runtime code", () => {
    const files = [
      ...RUNTIME_ROOTS.flatMap(collectSourceFiles),
      ...LIGHTWEIGHT_RUNTIME_HELPERS,
    ];
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const name of FORBIDDEN_NEXT_RUNTIME_ENVS) {
        const readsEnv =
          source.includes(`process.env.${name}`) ||
          source.includes(`process.env["${name}"]`) ||
          source.includes(`process.env['${name}']`);
        if (readsEnv) {
          violations.push(`${path.relative(process.cwd(), file)} reads ${name}`);
        }
      }
      const envNames = source.matchAll(/process\.env\.([A-Z0-9_]+)/g);
      for (const match of envNames) {
        const name = match[1];
        if (!ALLOWED_NEXT_RUNTIME_ENVS.has(name) && !name.startsWith("NEXT_PUBLIC_")) {
          violations.push(`${path.relative(process.cwd(), file)} reads unreviewed env ${name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
