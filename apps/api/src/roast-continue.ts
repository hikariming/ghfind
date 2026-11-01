import { WorkerEntrypoint } from "cloudflare:workers";
import { continueRoastJob } from "@/lib/roast-continue";

/**
 * RPC target for ghfind-coord RoastJob alarms. Generation runs here so the
 * coordination object never sees an LLM credential, and so the chain is not
 * bound to the browser request or to the 2-minute cron's 30s CPU cap.
 */
export class RoastContinueEntrypoint extends WorkerEntrypoint {
  async run(username: string, lang: string, owner: string): Promise<{ ok: boolean; status: string }> {
    return continueRoastJob(username, lang, owner);
  }
}
