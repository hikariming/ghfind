"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Link } from "@/i18n/navigation";
import {
  COMMENT_MAX_LENGTH,
  normalizeCommentText,
  type CreateProfileCommentResponse,
  type ProfileComment,
} from "@/lib/comments";

type FloatingCommentAuthor =
  | { type: "anonymous" }
  | { type: "github"; username: string; avatarUrl?: string | null };

interface FloatingCommentBubble {
  side: "left" | "right";
  author: FloatingCommentAuthor;
  text: string;
  top: string;
  laneOffset: string;
  delay: string;
  duration: string;
}

type FloatingCommentLang = "zh" | "en";

interface FloatingCommentLabels {
  anonymous: string;
  anonymousActive: string;
  button: string;
  cancel: string;
  failed: string;
  panelTitle: string;
  placeholder: string;
  send: string;
  sending: string;
}

const INITIAL_COMMENT_BUBBLES: Record<FloatingCommentLang, FloatingCommentBubble[]> = {
  zh: [
    {
      side: "left",
      author: { type: "github", username: "gaearon" },
      text: "这才是开源履历该有的含金量",
      top: "3.5rem",
      laneOffset: "1.4rem",
      delay: "-1.2s",
      duration: "9s",
    },
    {
      side: "left",
      author: { type: "anonymous" },
      text: "项目质量很硬",
      top: "16rem",
      laneOffset: "4.6rem",
      delay: "-4.1s",
      duration: "11s",
    },
    {
      side: "left",
      author: { type: "github", username: "yyx990803" },
      text: "社区影响力拉满",
      top: "28rem",
      laneOffset: "0rem",
      delay: "-2.6s",
      duration: "10s",
    },
    {
      side: "left",
      author: { type: "anonymous" },
      text: "这个标签比简历还会说话",
      top: "47rem",
      laneOffset: "5.8rem",
      delay: "-6.5s",
      duration: "12s",
    },
    {
      side: "right",
      author: { type: "github", username: "sindresorhus" },
      text: "一看就是榜单常驻选手",
      top: "6.8rem",
      laneOffset: "3.2rem",
      delay: "-3s",
      duration: "10.5s",
    },
    {
      side: "right",
      author: { type: "anonymous" },
      text: "分数和关注度都站得住",
      top: "19rem",
      laneOffset: "0.6rem",
      delay: "-5.4s",
      duration: "9.5s",
    },
    {
      side: "right",
      author: { type: "github", username: "torvalds" },
      text: "值得点进 GitHub 看看",
      top: "36rem",
      laneOffset: "4.8rem",
      delay: "-1.8s",
      duration: "12.5s",
    },
    {
      side: "right",
      author: { type: "anonymous" },
      text: "这个评分很难不服",
      top: "54rem",
      laneOffset: "1.8rem",
      delay: "-7.2s",
      duration: "11.5s",
    },
  ],
  en: [
    {
      side: "left",
      author: { type: "github", username: "gaearon" },
      text: "This open-source track record has real weight",
      top: "3.5rem",
      laneOffset: "1.4rem",
      delay: "-1.2s",
      duration: "9s",
    },
    {
      side: "left",
      author: { type: "anonymous" },
      text: "Project quality checks out",
      top: "16rem",
      laneOffset: "4.6rem",
      delay: "-4.1s",
      duration: "11s",
    },
    {
      side: "left",
      author: { type: "github", username: "yyx990803" },
      text: "Community signal is loud",
      top: "28rem",
      laneOffset: "0rem",
      delay: "-2.6s",
      duration: "10s",
    },
    {
      side: "left",
      author: { type: "anonymous" },
      text: "Those tags say more than a resume",
      top: "47rem",
      laneOffset: "5.8rem",
      delay: "-6.5s",
      duration: "12s",
    },
    {
      side: "right",
      author: { type: "github", username: "sindresorhus" },
      text: "Looks like a Hall of Fame regular",
      top: "6.8rem",
      laneOffset: "3.2rem",
      delay: "-3s",
      duration: "10.5s",
    },
    {
      side: "right",
      author: { type: "anonymous" },
      text: "Score and attention both hold up",
      top: "19rem",
      laneOffset: "0.6rem",
      delay: "-5.4s",
      duration: "9.5s",
    },
    {
      side: "right",
      author: { type: "github", username: "torvalds" },
      text: "Worth opening the GitHub profile",
      top: "36rem",
      laneOffset: "4.8rem",
      delay: "-1.8s",
      duration: "12.5s",
    },
    {
      side: "right",
      author: { type: "anonymous" },
      text: "Hard to argue with this score",
      top: "54rem",
      laneOffset: "1.8rem",
      delay: "-7.2s",
      duration: "11.5s",
    },
  ],
};

const ANONYMOUS_LABEL: Record<FloatingCommentLang, string> = {
  zh: "匿名",
  en: "Anonymous",
};

const COMMENT_LABELS: Record<FloatingCommentLang, FloatingCommentLabels> = {
  zh: {
    anonymous: "匿名",
    anonymousActive: "匿名",
    button: "留言",
    cancel: "取消",
    failed: "发送失败，稍后再试",
    panelTitle: "发送留言",
    placeholder: "写点狠的 🔥",
    send: "发送",
    sending: "发送中",
  },
  en: {
    anonymous: "Anonymous",
    anonymousActive: "Anonymous",
    button: "Message",
    cancel: "Cancel",
    failed: "Failed to send. Try again.",
    panelTitle: "Leave a message",
    placeholder: "Write a quick note 🔥",
    send: "Send",
    sending: "Sending",
  },
};

const FLOATING_COMMENT_SIDE_ROOM = "calc((100vw - 42rem) / 2 - 2rem)";
const FLOATING_COMMENT_CENTER_GAP = "1rem";
const FLOATING_COMMENT_CENTER_HALF_WIDTH = "21rem";
const MOBILE_DANMAKU_MIN_COUNT = 16;
const MOBILE_DANMAKU_TOPS = [
  "0.5rem",
  "3rem",
  "5.5rem",
  "8rem",
  "10.5rem",
  "13rem",
  "15.5rem",
];

function bubbleStyle(bubble: FloatingCommentBubble): CSSProperties {
  const laneOffset = `min(${bubble.laneOffset}, 5vw)`;
  const sideOffset = `calc(50% + ${FLOATING_COMMENT_CENTER_HALF_WIDTH} + ${FLOATING_COMMENT_CENTER_GAP} + ${laneOffset})`;

  return {
    top: bubble.top,
    maxWidth: `min(14rem, calc(${FLOATING_COMMENT_SIDE_ROOM} - ${laneOffset}))`,
    animationDelay: bubble.delay,
    animationDuration: bubble.duration,
    ...(bubble.side === "left" ? { right: sideOffset } : { left: sideOffset }),
  };
}

function mobileDanmakuStyle(index: number): CSSProperties {
  return {
    top: MOBILE_DANMAKU_TOPS[index % MOBILE_DANMAKU_TOPS.length],
    animationDelay: `-${(index * 2.7) % 24}s`,
    animationDuration: `${18 + (index % 5) * 2}s`,
  };
}

function repeatForMobileDanmaku(bubbles: FloatingCommentBubble[]): FloatingCommentBubble[] {
  if (bubbles.length === 0) return [];
  if (bubbles.length >= MOBILE_DANMAKU_MIN_COUNT) return bubbles;
  return Array.from(
    { length: MOBILE_DANMAKU_MIN_COUNT },
    (_, index) => bubbles[index % bubbles.length],
  );
}

function floatingCommentFromProfileComment(
  comment: ProfileComment,
  index: number,
): FloatingCommentBubble {
  const rightSide = index % 2 === 0;
  const topSlots = ["10rem", "24rem", "41rem", "60rem", "73rem", "88rem"];
  const laneOffsets = ["0.8rem", "4.4rem", "2.1rem", "6rem", "0rem", "3.5rem"];

  return {
    side: rightSide ? "right" : "left",
    author: comment.author,
    text: comment.text,
    top: topSlots[index % topSlots.length],
    laneOffset: laneOffsets[index % laneOffsets.length],
    delay: "0s",
    duration: "10s",
  };
}

function githubAvatarUrl(author: Extract<FloatingCommentAuthor, { type: "github" }>) {
  return author.avatarUrl ?? `https://github.com/${encodeURIComponent(author.username)}.png?size=32`;
}

function FloatingCommentAuthorLabel({
  author,
  lang,
}: {
  author: FloatingCommentAuthor;
  lang: FloatingCommentLang;
}) {
  const className =
    "mb-1.5 inline-flex max-w-full min-w-14 items-center rounded-full bg-black/35 px-2 py-0.5 text-left text-[10px] font-semibold leading-none text-orange-300/60 ring-1 ring-orange-300/10";

  if (author.type === "anonymous") {
    return <span className={className}>{ANONYMOUS_LABEL[lang]}</span>;
  }

  return (
    <Link
      href={`/u/${author.username}`}
      prefetch={false}
      className={`${className} pointer-events-auto gap-1.5 pl-1 underline-offset-2 hover:text-orange-200 hover:underline`}
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-full border border-orange-300/20 bg-zinc-900 bg-cover bg-center"
        style={{ backgroundImage: `url(${githubAvatarUrl(author)})` }}
      />
      <span className="truncate">@{author.username}</span>
    </Link>
  );
}

function FloatingCommentInlineAuthor({
  author,
  lang,
}: {
  author: FloatingCommentAuthor;
  lang: FloatingCommentLang;
}) {
  const className =
    "inline-flex shrink-0 items-center rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-semibold leading-none text-orange-300/70 ring-1 ring-orange-300/10";

  if (author.type === "anonymous") {
    return <span className={className}>{ANONYMOUS_LABEL[lang]}</span>;
  }

  return (
    <Link
      href={`/u/${author.username}`}
      prefetch={false}
      className={`${className} pointer-events-auto gap-1.5 pl-1 hover:text-orange-200`}
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-full border border-orange-300/20 bg-zinc-900 bg-cover bg-center"
        style={{ backgroundImage: `url(${githubAvatarUrl(author)})` }}
      />
      <span className="max-w-20 truncate">@{author.username}</span>
    </Link>
  );
}

export function FloatingCommentBubbles({
  initialComments,
  lang,
  profileUsername,
}: {
  initialComments: ProfileComment[];
  lang: FloatingCommentLang;
  profileUsername: string;
}) {
  const labels = COMMENT_LABELS[lang];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [comments, setComments] = useState<ProfileComment[]>(initialComments);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const bubbles = [
    ...INITIAL_COMMENT_BUBBLES[lang],
    ...comments.map(floatingCommentFromProfileComment),
  ];
  const mobileDanmakuBubbles = repeatForMobileDanmaku(bubbles);
  const trimmedDraft = normalizeCommentText(draft);
  const canSend = Boolean(trimmedDraft) && !sending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedDraft || sending) return;

    setSending(true);
    setFailed(false);
    try {
      const response = await fetch(
        `/api/profile-comments/${encodeURIComponent(profileUsername)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anonymous, text: trimmedDraft }),
        },
      );
      if (!response.ok) throw new Error("comment_failed");

      const payload = (await response.json()) as CreateProfileCommentResponse;
      setComments((current) => [...current, payload.comment]);
      setDraft("");
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-0 hidden lg:block">
        {bubbles.map((bubble, index) => (
          <div
            key={`${bubble.side}-${index}`}
            className="floating-comment-bubble absolute w-max min-w-0 max-w-[14rem]"
            style={bubbleStyle(bubble)}
          >
            <div className="flex w-full min-w-0 flex-col items-start rounded-2xl border border-orange-300/15 bg-zinc-950/60 px-3.5 py-2.5 text-orange-200/90 shadow-[0_16px_44px_rgba(0,0,0,0.42)] ring-1 ring-white/[0.05] backdrop-blur-sm">
              <FloatingCommentAuthorLabel author={bubble.author} lang={lang} />
              <span className="max-w-full whitespace-normal break-words text-xs font-semibold leading-relaxed text-orange-200 [overflow-wrap:anywhere] sm:text-sm">
                {bubble.text}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="pointer-events-none fixed inset-x-0 top-16 z-20 h-72 overflow-hidden lg:hidden">
        {mobileDanmakuBubbles.map((bubble, index) => (
          <div
            key={`mobile-${bubble.side}-${index}-${bubble.text}`}
            className="mobile-danmaku-comment absolute left-0 inline-flex max-w-[88vw]"
            style={mobileDanmakuStyle(index)}
          >
            <div className="inline-flex max-w-[88vw] items-center gap-2 rounded-full border border-orange-300/15 bg-zinc-950/60 px-2.5 py-1.5 text-orange-200/90 shadow-[0_10px_30px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.05] backdrop-blur-sm">
              <FloatingCommentInlineAuthor author={bubble.author} lang={lang} />
              <span className="min-w-0 truncate text-xs font-semibold text-orange-200">
                {bubble.text}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
        {open && (
          <form
            onSubmit={handleSubmit}
            className="w-[min(calc(100vw-2.5rem),22rem)] rounded-2xl border border-orange-300/20 bg-zinc-950/95 p-4 text-left shadow-2xl ring-1 ring-white/[0.06] backdrop-blur"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold text-orange-200">{labels.panelTitle}</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full px-2 py-1 text-xs text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
              >
                {labels.cancel}
              </button>
            </div>

            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(Array.from(event.target.value).slice(0, COMMENT_MAX_LENGTH).join(""));
                setFailed(false);
              }}
              rows={4}
              maxLength={COMMENT_MAX_LENGTH}
              placeholder={labels.placeholder}
              className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm leading-relaxed text-orange-100 outline-none placeholder:text-zinc-600 focus:border-orange-400/50"
            />

            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                aria-pressed={anonymous}
                onClick={() => setAnonymous((value) => !value)}
                className="rounded-full border border-orange-300/20 bg-black/35 px-3 py-1 text-xs font-semibold text-orange-200/80 hover:bg-orange-950/40 aria-pressed:bg-orange-500/15 aria-pressed:text-orange-100"
              >
                {anonymous ? labels.anonymousActive : labels.anonymous}
              </button>
              <span className="text-[11px] tabular-nums text-zinc-600">
                {Array.from(draft).length}/{COMMENT_MAX_LENGTH}
              </span>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              {failed ? (
                <span className="text-xs text-red-300/80">{labels.failed}</span>
              ) : (
                <span aria-hidden="true" />
              )}
              <button
                type="submit"
                disabled={!canSend}
                className="rounded-full bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-orange-950/30 hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? labels.sending : labels.send}
              </button>
            </div>
          </form>
        )}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-full border border-orange-300/30 bg-orange-600 px-4 py-2 text-sm font-bold text-white shadow-[0_18px_50px_rgba(0,0,0,0.45)] hover:bg-orange-500"
        >
          {labels.button}
        </button>
      </div>
    </>
  );
}
