import { useTranslations } from "next-intl";

export function useFeedErrorMessage() {
  const t = useTranslations("stream");
  return (code: string) => {
    if (code === "score_identity_required" || code === "score_identity_mismatch") return t("feed.verifyScore");
    if (code === "login_required" || code === "unauthorized") return t("feed.loginRequired");
    if (code === "publishing_denied" || code === "score_required" || code === "github_required") return t("feed.publishRequirement");
    if (code === "rate_limited") return t("feed.rateLimited");
    if (code === "post_unavailable") return t("feed.unavailable");
    if (code === "media_count") return t("feed.mediaCount");
    if (code === "media_invalid" || code === "invalid_media" || code === "file_too_large" || code === "media_too_large" || code === "invalid_media_type") return t("feed.mediaInvalid");
    return t("feed.requestFailed");
  };
}
