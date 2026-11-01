import { runAutoReroastQueue } from "@/lib/auto-reroast-worker";
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

/**
 * Cron entry for the on-view auto re-roast queue (src/lib/auto-reroast*.ts).
 * Pause with GHFIND_AUTO_REROAST_DISABLED=1; the queue then just ages out.
 */
export async function scheduledAutoReroast(
  waitUntil: (promise: Promise<unknown>) => void,
  run: typeof runAutoReroastQueue = runAutoReroastQueue,
): Promise<Awaited<ReturnType<typeof runAutoReroastQueue>>> {
  const request = new Request("https://ghfind-api.internal/scheduled/auto-reroast");
  try {
    const result = await requestContext.run({ request, waitUntil }, () => run());
    if (result.status !== "ran" || result.processed) {
      console.log(JSON.stringify({ event: "auto_reroast_cron", ...result }));
    }
    return result;
  } catch (error) {
    console.error("auto_reroast_cron failed", error);
    return { status: "unavailable" };
  }
}
