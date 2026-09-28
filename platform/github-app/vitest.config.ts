import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery } from "wrangler";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_ID: "123",
          APP_SLUG: "ghfind-review-test",
          ENABLED: "true",
          ALLOWED_ACCOUNTS: "AsperforMias",
          APP_PRIVATE_KEY: privateKey,
          WEBHOOK_SECRET: "test-webhook-secret",
          SESSION_SECRET: "test-session-secret",
          APP_CLIENT_SECRET: "test-client-secret",
        },
        serviceBindings: {
          SCORE: async () => Response.json({ final_score: 82.7 }),
        },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"], fileParallelism: false },
  define: {
    TEST_SQL: JSON.stringify(
      unstable_splitSqlQuery(
        [
          "0001_jobs.sql",
          "0002_author_email.sql",
          "0003_email_delivery_receipt.sql",
          "0004_default_author_email.sql",
          "0005_comment_and_email_limits.sql",
        ]
          .map((f) => readFileSync(`migrations/${f}`, "utf8"))
          .join("\n"),
      ),
    ),
  },
});
