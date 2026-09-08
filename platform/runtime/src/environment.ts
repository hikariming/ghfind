import { checkConfiguration, type RuntimeSettings } from "./router";

export function containerEnvironment(
  env: RuntimeSettings,
  role: "api" | "executor",
): Record<string, string> {
  checkConfiguration(env);
  return {
    PORT: "8080",
    FEED_STORE_PROFILE: "cf_d1_r2",
    FEED_MODE: env.FEED_MODE,
    FEED_WRITER_EPOCH: env.FEED_WRITER_EPOCH,
    FEED_GATEWAY_SECRET: env.FEED_GATEWAY_SECRET,
    FEED_SIGNING_SECRET: env.FEED_SIGNING_SECRET,
    FEED_BRIDGE_SECRET: env.FEED_BRIDGE_SECRET,
    FEED_BRIDGE_ENDPOINT: "http://feed-bindings.internal",
    FEED_EXECUTOR_SECRET: env.FEED_EXECUTOR_SECRET,
    FEED_EXECUTOR_ENABLED: env.FEED_EXECUTOR_ENABLED,
    FEED_SOURCE_ENDPOINT: "http://feed-source.internal",
    FEED_SOURCE_SECRET: env.FEED_SOURCE_SECRET,
    FEED_CLEANUP_ENDPOINT: "http://feed-cleanup.internal",
    ...(role === "executor"
      ? { FEED_ARCHIVE_ENDPOINT: "http://feed-archive.internal" }
      : {}),
  };
}
