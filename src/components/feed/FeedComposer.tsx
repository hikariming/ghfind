"use client";

import { useId, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { feedClient } from "@/lib/social-feed/client";
import { FEED_MAX_TEXT_LENGTH, type FeedMedia } from "@/lib/social-feed/contract";
import { feedError, type FeedStore } from "@/lib/social-feed/client-store";
import { useMountEffect } from "@/lib/use-mount-effect";
import { cn } from "@/lib/utils";
import { FeedAvatar } from "./FeedAvatar";
import { useFeedErrorMessage } from "./messages";

interface Attachment {
  id: string;
  file: File;
  url: string;
  alt: string;
  uploaded?: FeedMedia;
}
interface PendingPublication {
  text: string;
  mediaIds: string[];
  key: string;
}
interface ComposerProps {
  store: FeedStore;
  parentId?: string;
}

export function FeedLogin({ store }: { store: FeedStore }) {
  const me = useStore(store, (state) => state.me);
  const loginText = useTranslations("loginDialog");
  if (!me) return null;
  return <Button variant="outline" onClick={() => store.getState().setLoginOpen(true)}>{loginText("entry")}</Button>;
}

function PublicationNotice({ store, parentId, open, onOpenChange }: ComposerProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("stream");
  const me = useStore(store, (state) => state.me);
  const capabilities = useStore(store, (state) => state.capabilities);
  const capabilitiesError = useStore(store, (state) => state.capabilitiesError);
  const failed = capabilitiesError || Boolean(me?.loadFailed) || capabilities?.reason === "score_unavailable";
  const reason = capabilities?.reason;
  const needsScore = reason === "score_required";
  const belowMinimum = reason === "score_below_minimum";
  const identityUnavailable = ["score_identity_required", "score_identity_mismatch", "score_outdated"].includes(reason ?? "");
  const allowed = parentId ? capabilities?.can_reply : capabilities?.can_publish;
  return <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
    <DialogContent
      className="w-[min(calc(100vw-2rem),23rem)] translate-x-0 translate-y-0 gap-3 bg-background p-4"
      style={{ left: "50%", top: "clamp(5rem, 18vh, 12rem)", bottom: "auto", translate: "none", transform: "translateX(-50%)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <DialogTitle className="text-base">{t("feed.publishAccessTitle")}</DialogTitle>
        <DialogClose asChild><Button variant="ghost" size="icon" className="-me-1 -mt-1 size-8" aria-label={t("close")}><X className="size-4" aria-hidden /></Button></DialogClose>
      </div>
      <DialogDescription className="text-sm leading-6 text-muted-foreground">{t("feed.publishRequirement")}</DialogDescription>
      {failed ? <p role="status" className="text-xs text-muted-foreground">{t("feed.capabilitiesError")}</p>
        : !me || !capabilities ? <p role="status" className="text-xs text-muted-foreground">{t("feed.checking")}</p>
        : belowMinimum ? <p className="text-xs text-muted-foreground">{t("feed.scoreBelowMinimum")}</p>
        : needsScore ? <p className="text-xs text-muted-foreground">{t("feed.scoreMissing")}</p>
        : identityUnavailable ? <p role="status" className="text-xs text-muted-foreground">{t("feed.verifyScore")}</p> : null}
      <div className="flex items-center justify-end gap-2">
        {me && !me.user ? <FeedLogin store={store} /> : null}
        {failed || identityUnavailable ? <Button size="sm" variant="outline" onClick={() => void store.getState().refreshSession()}>{t("feed.retry")}</Button>
          : me?.user && !allowed && needsScore ? <Button asChild size="sm" shape="pill"><Link href={`/u/${me.user.login}`} prefetch={false}>{t("railCtaButton")}</Link></Button> : null}
      </div>
    </DialogContent>
  </Dialog>;
}

function resizeComposer(input: HTMLTextAreaElement) {
  input.style.height = "0px";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 64), 320)}px`;
}

export function FeedComposer({ store, parentId }: ComposerProps) {
  const me = useStore(store, (state) => state.me);
  return <WritableComposer key={`${me?.user?.login ?? me?.account?.subject ?? "guest"}:${parentId ?? "original"}`} store={store} parentId={parentId} />;
}

function WritableComposer({ store, parentId }: ComposerProps) {
  const t = useTranslations("stream");
  const message = useFeedErrorMessage();
  const me = useStore(store, (state) => state.me);
  const capabilities = useStore(store, (state) => state.capabilities);
  const capabilitiesError = useStore(store, (state) => state.capabilitiesError);
  const [accessOpen, setAccessOpen] = useState(false);
  const [text, setText] = useState("");
  const [replyExpanded, setReplyExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editingAlt, setEditingAlt] = useState<string | null>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const submitLock = useRef(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const idempotency = useRef<string | null>(null);
  const inputId = useId();
  const urls = useRef(new Set<string>());
  const draftKey = `ghfind.feed.draft:${me?.user?.login ?? me?.account?.subject ?? "guest"}:${parentId ?? "original"}`;
  const requestKey = `${draftKey}:request`;
  const length = Array.from(text).length;
  const compactReply = Boolean(parentId && !replyExpanded && !text && !attachments.length);

  useMountEffect(() => {
    try {
      const guestKey = `ghfind.feed.draft:guest:${parentId ?? "original"}`;
      const saved = sessionStorage.getItem(draftKey) ?? sessionStorage.getItem(guestKey) ?? "";
      if (saved && draftKey !== guestKey) {
        sessionStorage.setItem(draftKey, saved);
        sessionStorage.removeItem(guestKey);
      }
      setText(saved);
      if (!parentId && textInput.current) {
        textInput.current.value = saved;
        resizeComposer(textInput.current);
      }
    } catch { /* Storage can be unavailable in private browser contexts. */ }
    const objectUrls = urls.current;
    return () => objectUrls.forEach((url) => URL.revokeObjectURL(url));
  });

  const updateText = (value: string) => {
    setText(value);
    setError(null);
    setPublished(false);
    idempotency.current = null;
    try {
      if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey);
      sessionStorage.removeItem(requestKey);
    } catch { /* In-memory editing remains available. */ }
  };
  const selectFiles = (files: FileList | File[] | null) => {
    if (!files?.length || submitLock.current) return;
    setError(null);
    if (files.length + attachments.length > 4) { setError("media_count"); return; }
    const selected: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) || file.size === 0 || file.size > 10 * 1024 * 1024) { setError("media_invalid"); return; }
    }
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      selected.push({ id: crypto.randomUUID(), file, url, alt: "" });
    }
    setAttachments((previous) => [...previous, ...selected]);
    textInput.current?.focus();
    idempotency.current = null;
    setPublished(false);
  };
  const submit = async () => {
    if (submitLock.current || pending) return;
    if (me && !me.user && !me.account) { store.getState().setLoginOpen(true); return; }
    const allowed = parentId ? capabilities?.can_reply : capabilities?.can_publish;
    if (!me?.user || !allowed || capabilitiesError || me.loadFailed || capabilities?.reason === "score_unavailable") {
      setAccessOpen(true);
      return;
    }
    if ((!text.trim() && !attachments.length) || length > FEED_MAX_TEXT_LENGTH) {
      textInput.current?.focus();
      return;
    }
    submitLock.current = true;
    setPending(true);
    setError(null);
    try {
      const uploaded: Attachment[] = [];
      for (const attachment of attachments) {
        const media = attachment.uploaded ?? await feedClient.upload(attachment.file, attachment.alt);
        const next = { ...attachment, uploaded: media };
        uploaded.push(next);
        setAttachments((current) => current.map((item) => item.id === next.id ? next : item));
      }
      const mediaIds = uploaded.map((item) => item.uploaded!.id);
      // A lost success response must remain safe to retry after reopening the composer.
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(requestKey) ?? "null");
        if (saved && typeof saved === "object" && "text" in saved && "mediaIds" in saved && "key" in saved && saved.text === text && JSON.stringify(saved.mediaIds) === JSON.stringify(mediaIds) && typeof saved.key === "string") idempotency.current = saved.key;
      } catch { /* Retry identity is kept in memory when storage is unavailable. */ }
      idempotency.current ??= crypto.randomUUID();
      const publication: PendingPublication = { text, mediaIds, key: idempotency.current };
      try { sessionStorage.setItem(requestKey, JSON.stringify(publication)); } catch { /* In-memory retry remains idempotent. */ }
      await store.getState().publish(text, publication.key, parentId, mediaIds);
      // A reply may finish after its composer was closed and a newer draft was written.
      try {
        if (sessionStorage.getItem(draftKey) === text) sessionStorage.removeItem(draftKey);
        if (sessionStorage.getItem(requestKey) === JSON.stringify(publication)) sessionStorage.removeItem(requestKey);
      } catch { /* The server-confirmed post remains the source of truth. */ }
      setText("");
      idempotency.current = null;
      attachments.forEach((attachment) => { URL.revokeObjectURL(attachment.url); urls.current.delete(attachment.url); });
      setAttachments([]);
      setPublished(true);
      setEditingAlt(null);
      if (!parentId && textInput.current) {
        textInput.current.value = "";
        resizeComposer(textInput.current);
      }
    } catch (failure) {
      const code = feedError(failure);
      if (code === "login_required") {
        store.getState().setLoginOpen(true);
        void store.getState().refreshSession();
      } else if (code === "publishing_denied") {
        setAccessOpen(true);
        void store.getState().refreshSession();
      } else setError(code);
    }
    finally { submitLock.current = false; setPending(false); }
  };
  return <>
  <form
    className={cn("relative border-b border-border bg-background", parentId ? "px-3 py-3 sm:px-4" : "px-4 pb-2 pt-4", dragging && "ring-2 ring-inset ring-primary")}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onFocus={() => setFocused(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onDragEnter={(event) => {
      if (!event.dataTransfer.types.includes("Files") || pending) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      selectFiles(event.dataTransfer.files);
    }}
    aria-busy={pending}
  >
    <div className={cn("flex", parentId ? "gap-2.5" : "gap-3")}>
      {me?.user || me?.account ? <FeedAvatar key={me.user?.image ?? me.account?.image} name={me.user?.login ?? me.account?.name ?? ""} src={me.user?.image ?? me.account?.image ?? null} score={capabilities?.score} />
        : <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground" aria-hidden><UserRound className="size-5" /></span>}
      <div className={cn("min-w-0 flex-1", compactReply && "flex items-center gap-3")}>
        <Textarea
          ref={textInput}
          style={{ outline: "none" }}
          value={text}
          onFocus={() => setReplyExpanded(true)}
          onChange={(event) => { updateText(event.currentTarget.value); if (!parentId) resizeComposer(event.currentTarget); }}
          onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); selectFiles(event.clipboardData.files); } }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
          placeholder={t(parentId ? "replyPlaceholder" : "feed.composerPlaceholder")}
          aria-label={t(parentId ? "replyPlaceholder" : "feed.composerPlaceholder")}
          aria-invalid={length > FEED_MAX_TEXT_LENGTH}
          className={cn("min-w-0 rounded-none border-0 bg-transparent px-0 py-1 shadow-none focus-visible:ring-0", parentId ? compactReply ? "min-h-10 flex-1 resize-none text-lg leading-8" : "min-h-[74px] resize-y text-[15px]" : "min-h-16 resize-none pb-3 text-xl leading-7")}
          disabled={pending}
          rows={compactReply ? 1 : 2}
        />
        {attachments.length ? <div className={cn("mb-3 grid gap-0.5 overflow-hidden rounded-2xl border border-border", attachments.length > 1 && "aspect-[4/3] grid-cols-2", attachments.length > 2 && "grid-rows-2")}>
          {attachments.map((attachment, index) => <div key={attachment.id} className={cn("relative min-h-0 min-w-0 overflow-hidden bg-muted", attachments.length === 3 && index === 0 && "row-span-2")}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, uploaded only on submit */}
            <img src={attachment.url} alt={attachment.alt} className={cn("w-full object-cover", attachments.length === 1 ? "max-h-96 object-contain" : "h-full")} />
            <Button type="button" size="icon" variant="ghost" disabled={pending} className="absolute end-1.5 top-1.5 size-8 bg-black/70 text-white hover:bg-black/90 hover:text-white" aria-label={t("feed.removeImage")} onClick={() => { setAttachments((current) => current.filter((item) => item.id !== attachment.id)); URL.revokeObjectURL(attachment.url); urls.current.delete(attachment.url); idempotency.current = null; }}><X className="size-4" aria-hidden /></Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} className="absolute bottom-2 start-2 h-6 bg-black/70 px-2 text-[11px] font-bold text-white hover:bg-black/90 hover:text-white" aria-label={t("feed.imageDescription")} onClick={() => setEditingAlt(editingAlt === attachment.id ? null : attachment.id)}>ALT</Button>
          </div>)}
        </div> : null}
        {attachments.filter((attachment) => attachment.id === editingAlt).map((attachment) => <Input key={attachment.id} autoFocus className="mb-3 h-9 text-sm" value={attachment.alt} maxLength={1000} disabled={pending} placeholder={t("feed.imageDescription")} aria-label={t("feed.imageDescription")} onChange={(event) => { setAttachments((current) => current.map((item) => item.id === attachment.id ? { ...item, alt: event.target.value, uploaded: undefined } : item)); idempotency.current = null; }} />)}
        <div className={cn("flex items-center justify-between gap-2", compactReply ? "shrink-0" : parentId || focused ? "min-h-11 border-t border-border pt-2" : "min-h-11")}>
          <div className={compactReply ? "hidden" : undefined}>
            <Button type="button" size="icon" variant="ghost" disabled={pending || attachments.length >= 4} className="-ms-2 size-9 text-primary hover:bg-primary/10 hover:text-primary" aria-label={t("feed.addImage")} title={t("feed.addImage")} onClick={() => fileInput.current?.click()}><ImagePlus className="size-5" aria-hidden /></Button>
            <Input ref={fileInput} id={inputId} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple disabled={pending || attachments.length >= 4} className="hidden" tabIndex={-1} aria-label={t("feed.addImage")} onChange={(event) => { selectFiles(event.target.files); event.target.value = ""; }} />
          </div>
          <div className="flex items-center gap-3">
            {length > FEED_MAX_TEXT_LENGTH * 0.8 ? <span className={cn("text-xs tabular-nums", length > FEED_MAX_TEXT_LENGTH ? "text-destructive" : "text-muted-foreground")}>{length}/{FEED_MAX_TEXT_LENGTH}</span> : null}
            <Button type="submit" size="sm" shape="pill" disabled={pending || length > FEED_MAX_TEXT_LENGTH} className={cn("px-4", !parentId && "h-9 min-w-16 bg-foreground text-sm font-bold text-background shadow-none hover:bg-foreground/90")}>
              {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
              {t(pending ? "feed.publishing" : parentId ? "replySend" : "feed.publish")}
            </Button>
          </div>
        </div>
        {error ? <p role="alert" className="mt-2 text-sm leading-5 text-destructive">{message(error)}</p> : null}
        {published ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("feed.published")}</p> : null}
      </div>
    </div>
    {dragging ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/95 text-sm font-medium text-primary"><ImagePlus className="me-2 size-5" aria-hidden />{t("feed.addImage")}</div> : null}
  </form>
  <PublicationNotice store={store} parentId={parentId} open={accessOpen} onOpenChange={setAccessOpen} />
  </>;
}
