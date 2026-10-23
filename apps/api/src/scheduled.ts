import { reconcilePendingProjectAnalyses } from "@/lib/project-analysis-service";
import { requestContext } from "./request-context";

// Cron entry for project-analysis reconcile (triggers in wrangler.jsonc, production).
// Batch size of the operator reconcile route (src/app/api/internal/project-analyses/reconcile).
export const PROJECT_ANALYSIS_RECONCILE_BATCH = 20;

export async function scheduledProjectAnalysisReconcile(
  waitUntil: (promise: Promise<unknown>) => void,
  reconcile: (limit: number) => ReturnType<typeof reconcilePendingProjectAnalyses> = reconcilePendingProjectAnalyses,
): Promise<{ status: "disabled" } | ({ status: "ran" } & Awaited<ReturnType<typeof reconcilePendingProjectAnalyses>>)> {
  if ((process.env.PROJECT_ANALYSIS_RECONCILE_CRON ?? "").trim().toLowerCase() === "off") {
    console.log(JSON.stringify({ event: "project_analysis_reconcile_cron", status: "disabled" }));
    return { status: "disabled" };
  }
  const request = new Request("https://ghfind-api.internal/scheduled/project-analyses/reconcile");
  const result = await requestContext.run({ request, waitUntil }, () => reconcile(PROJECT_ANALYSIS_RECONCILE_BATCH));
  console.log(JSON.stringify({ event: "project_analysis_reconcile_cron", status: "ran", ...result }));
  return { status: "ran", ...result };
}
