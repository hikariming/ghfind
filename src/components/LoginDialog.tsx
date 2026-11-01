"use client";

import { useState } from "react";
import { LoaderCircle, LogIn, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { loginProviders, type LoginProvider, type Me } from "@/lib/me-client";
import { signInWithProvider } from "@/lib/oauth-client";
import { useMountEffect } from "@/lib/use-mount-effect";

const PROVIDERS: LoginProvider[] = ["google", "github", "apple"];
const PROVIDER_NAMES = { google: "Google", github: "GitHub", apple: "Apple" };

function GitHubMark() {
  return <svg viewBox="0 0 16 16" className="login-provider-mark fill-current" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}

function ProviderMark({ provider }: { provider: LoginProvider }) {
  if (provider === "github") return <GitHubMark />;
  // Official provider artwork is served locally; opening the dialog makes no third-party request.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/auth/${provider === "google" ? "google.png" : "apple.svg"}`} alt="" aria-hidden className={provider === "apple" ? "login-apple-mark" : "login-provider-mark"} />;
}

function errorMessageKey(value: string | null): "denied" | "expired" | "failed" | "unavailable" | null {
  if (value === "google_denied" || value === "apple_denied" || value === "github") return "denied";
  if (value === "invalid_state") return "expired";
  if (value === "auth_unavailable") return "unavailable";
  if (value === "google_failed" || value === "apple_failed") return "failed";
  return null;
}

export function LoginDialog({ me, onRetry, showTrigger = true, open: controlledOpen, onOpenChange, nearComposer = false }: { me: Me; onRetry: () => Promise<void>; showTrigger?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; nearComposer?: boolean }) {
  const t = useTranslations("loginDialog");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => { setInternalOpen(next); onOpenChange?.(next); };
  const [error, setError] = useState<ReturnType<typeof errorMessageKey>>(null);
  const [pending, setPending] = useState<LoginProvider | null>(null);
  const [retrying, setRetrying] = useState(false);
  const available = loginProviders(me);
  const providers = PROVIDERS.filter((provider) => available[provider]);

  useMountEffect(() => {
    const url = new URL(window.location.href);
    const message = errorMessageKey(url.searchParams.get("auth_error"));
    if (message) {
      setError(message);
      setOpen(true);
      // Consume callback errors so reloads and later sign-ins do not repeat them.
      url.searchParams.delete("auth_error");
      window.history.replaceState(window.history.state, "", url.href);
    }
    const reset = () => setPending(null);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  });

  const start = (provider: LoginProvider) => {
    if (pending) return;
    setError(null);
    setPending(provider);
    try { signInWithProvider(provider); } catch { setPending(null); setError("failed"); }
  };

  const retry = async () => {
    setRetrying(true);
    try { await onRetry(); } finally { setRetrying(false); }
  };

  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPending(null); }}>
    {showTrigger && <DialogTrigger asChild>
      <button type="button" className="sidebar-login" aria-label={t("entry")}>
        <LogIn size={16} aria-hidden /><span className="sidebar-label">{t("entry")}</span>
      </button>
    </DialogTrigger>}
    <DialogContent className="login-dialog" style={nearComposer ? { top: "clamp(5rem, 18vh, 12rem)", bottom: "auto", left: "50%", translate: "none", transform: "translateX(-50%)", maxHeight: "calc(82dvh - 2rem)", overflowY: "auto" } : undefined}>
      <div className="login-dialog-heading">
        <div>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="login-dialog-description">{t("description")}</DialogDescription>
        </div>
        <DialogClose className="login-dialog-close" aria-label={t("close")}><X size={18} aria-hidden /></DialogClose>
      </div>
      {error && <p className="login-dialog-error" role="alert">{t(`errors.${error}`)}</p>}
      <div className="login-dialog-providers" aria-busy={Boolean(pending) || retrying}>
        {providers.map((provider) => <button key={provider} type="button" className={`login-dialog-option login-provider-${provider}`} disabled={Boolean(pending)} onClick={() => start(provider)}>
          {pending === provider ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <ProviderMark provider={provider} />}
          <span>{pending === provider ? t("redirecting", { provider: PROVIDER_NAMES[provider] }) : t(provider)}</span>
        </button>)}
        {!providers.length && <>
          <p className="login-dialog-status" role="status">{t(me.loadFailed ? "loadFailed" : "unavailable")}</p>
          <button type="button" className="login-dialog-option" onClick={() => void retry()} disabled={retrying}>
            {retrying && <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />}{t(retrying ? "loading" : "retry")}
          </button>
        </>}
      </div>
      {(available.google || available.apple) && <p className="login-dialog-note">{t("githubFeatures")}</p>}
      <span className="sr-only" role="status" aria-live="polite">{pending ? t("redirecting", { provider: PROVIDER_NAMES[pending] }) : ""}</span>
    </DialogContent>
  </Dialog>;
}
