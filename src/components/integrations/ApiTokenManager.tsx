"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMountEffect } from "@/lib/use-mount-effect";

type Token = { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null };

export function ApiTokenManager({ signedIn, locale }: { signedIn: boolean; locale: string }) {
  const t = useTranslations("integrations.tokens");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(signedIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function fetchTokens() {
    setLoading(true);
    try {
      const response = await fetch("/api/account/tokens", { cache: "no-store" });
      const data = await response.json() as { tokens?: Token[] };
      if (!response.ok) throw new Error(t("loadError"));
      setTokens(data.tokens ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function createToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || t("defaultName") }),
      });
      const data = await response.json() as { error?: string; token?: string; record?: Token };
      if (!response.ok || !data.token || !data.record) throw new Error(data.error === "token_limit" ? t("limitError") : t("createError"));
      setSecret(data.token);
      setName("");
      setTokens(current => [data.record!, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createError"));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/account/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(t("revokeError"));
      setTokens(current => current.filter(token => token.id !== id));
      setSecret("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("revokeError"));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  useMountEffect(() => {
    if (!signedIn) return;
    void fetchTokens();
  });

  if (!signedIn) return <section id="api-tokens" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
    <h2 className="text-lg font-semibold">{t("heading")}</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("signedOut")}</p>
    <div className="mt-5 flex flex-col gap-2 sm:flex-row">
      <Input disabled placeholder={t("namePlaceholder")} aria-label={t("namePlaceholder")} />
      <a className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90" href={`/api/auth/github?callbackUrl=${encodeURIComponent(locale === "zh" ? "/integrations" : `/${locale}/integrations`)}`}><Plus size={16} />{t("signIn")}</a>
    </div>
  </section>;

  return <section id="api-tokens" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-lg font-semibold">{t("heading")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("description")}</p></div>
      <span className="text-xs text-muted-foreground">{t("limit", { count: tokens.length })}</span>
    </div>
    <form onSubmit={createToken} className="mt-5 flex flex-col gap-2 sm:flex-row">
      <Input value={name} onChange={event => setName(event.target.value)} maxLength={64} placeholder={t("namePlaceholder")} aria-label={t("namePlaceholder")} />
      <Button type="submit" disabled={busy || loading} className="shrink-0"><Plus size={16} />{busy ? t("working") : t("create")}</Button>
    </form>
    {secret && <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
      <p className="text-sm font-medium">{t("copyOnce")}</p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row"><code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">{secret}</code><Button type="button" variant="outline" onClick={() => void copySecret()}><>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? t("copied") : t("copy")}</></Button></div>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
    {loading ? <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={15} className="animate-spin" />{t("loading")}</p> : tokens.length === 0 ? <p className="mt-5 text-sm text-muted-foreground">{t("empty")}</p> : <ul className="mt-5 divide-y divide-border">
      {tokens.map(token => <li key={token.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="truncate text-sm font-medium">{token.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{token.prefix}•••• · {t("created", { date: new Date(token.createdAt).toLocaleDateString() })}</p></div><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void revokeToken(token.id)} aria-label={t("revoke", { name: token.name })}><Trash2 size={15} />{t("revokeShort")}</Button></li>)}
    </ul>}
  </section>;
}
