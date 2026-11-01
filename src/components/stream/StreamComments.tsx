"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MessageCircle, Send, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StreamComment } from "@/lib/stream/detail";
import { useStreamStore } from "@/lib/stream/store";
import type { StreamCommentTarget, StreamItem } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import { StreamAvatar } from "./StreamCard";

const ENDPOINT: Record<StreamCommentTarget["kind"], string> = {
  blog: "blog-comments",
  collection: "collection-comments",
  profile: "profile-comments",
};
/** Mirrors COMMENT_MAX_LENGTH in lib/comments.ts. */
const MAX_LENGTH = 80;
const QUICK_KINDS = new Set(["developer", "talent", "article", "collection"]);

export function threadKey(target: StreamCommentTarget): string {
  return `${target.kind}:${target.key}`;
}

type ApiComment = { id: string; author: { type: "anonymous" } | { type: "github"; username: string; avatarUrl?: string | null }; text: string; createdAt: number };

function fromApi(comment: ApiComment): StreamComment {
  return {
    id: comment.id,
    author: comment.author.type === "github"
      ? { name: comment.author.username, avatarUrl: comment.author.avatarUrl ?? null, anonymous: false }
      : { name: "", avatarUrl: null, anonymous: true },
    text: comment.text,
    createdAt: comment.createdAt,
  };
}

/**
 * Real comment thread for an item, using the site's existing comment APIs.
 * Posting is anonymous (no login wall) and one tap away via quick replies:
 * with a few thousand visitors a day, lowering the cost of the first comment
 * matters more than anything else here.
 */
export function StreamComments({
  item,
  comments,
  loading,
}: {
  item: StreamItem;
  comments: StreamComment[];
  loading: boolean;
}) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const target = item.comments;
  const posted = useStreamStore((state) => (target ? state.posted[threadKey(target)] : undefined));
  const addPosted = useStreamStore((state) => state.addPosted);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fixed at mount: comments sent after it are newer and read as "just now".
  const [now] = useState(() => Date.now());

  if (!target) {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-white/[0.02] px-3 py-2.5 text-xs text-muted-foreground">
        <MessageCircle className="size-3.5" aria-hidden />
        {t("commentsClosed")}
      </p>
    );
  }

  const postedIds = new Set((posted ?? []).map((comment) => comment.id));
  const all = [...(posted ?? []), ...comments.filter((comment) => !postedIds.has(comment.id))];

  const send = async (value: string) => {
    const body = value.trim().slice(0, MAX_LENGTH);
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/${ENDPOINT[target.kind]}/${encodeURIComponent(target.key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, anonymous: true }),
      });
      const payload = (await response.json().catch(() => null)) as { comment?: ApiComment; error?: string } | null;
      if (!response.ok || !payload?.comment) {
        setError(payload?.error === "rate_limited" ? t("commentRateLimited") : payload?.error === "links_not_allowed" ? t("commentLinks") : t("commentFailed"));
        return;
      }
      addPosted(threadKey(target), fromApi(payload.comment));
      useStreamStore.getState().signal(item, "like");
      setText("");
    } catch {
      setError(t("commentFailed"));
    } finally {
      setSending(false);
    }
  };

  const quick = QUICK_KINDS.has(item.kind) ? (["a", "b", "c"] as const).map((key) => t(`quick.${item.kind}.${key}`)) : [];

  return (
    <div>
      <h4 className="flex items-center gap-1.5 text-sm font-bold text-foreground">
        {t("commentsTitle")}
        {all.length > 0 ? <span className="text-xs font-medium text-muted-foreground tabular-nums">{all.length}</span> : null}
      </h4>

      {loading && all.length === 0 ? (
        <div className="mt-2 space-y-2" aria-hidden>
          {[0, 1].map((index) => <div key={index} className="h-9 animate-pulse rounded-lg bg-muted" />)}
        </div>
      ) : all.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{t("commentsEmpty")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {all.map((comment) => (
              <motion.li key={comment.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2">
                {comment.author.anonymous ? (
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><UserRound className="size-3.5" aria-hidden /></span>
                ) : (
                  <StreamAvatar src={comment.author.avatarUrl} name={comment.author.name} className="size-7 text-xs" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground/90">{comment.author.anonymous ? t("anonymous") : `@${comment.author.name}`}</span>
                    <span className="ms-1.5">{now - comment.createdAt < 60_000 ? t("justNow") : relativeTime(new Date(comment.createdAt).toISOString(), now, locale)}</span>
                  </p>
                  <p className="break-words text-sm leading-5 text-foreground">{comment.text}</p>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {quick.length > 0 ? (
        <div className="mt-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {quick.map((reply) => (
            <button
              key={reply}
              type="button"
              disabled={sending}
              onClick={() => void send(reply)}
              className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground disabled:opacity-50"
            >
              {reply}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <Input
          value={text}
          maxLength={MAX_LENGTH}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("commentPlaceholder")}
          aria-label={t("commentPlaceholder")}
          className="h-9 flex-1 text-sm"
        />
        <Button type="submit" size="sm" disabled={sending || !text.trim()} aria-label={t("commentSend")} className="h-9">
          <Send className="size-3.5" />
        </Button>
      </form>
      <p className={cn("mt-1 text-[11px]", error ? "text-rose-400" : "text-muted-foreground")}>{error ?? t("commentAnonymousHint")}</p>
    </div>
  );
}
