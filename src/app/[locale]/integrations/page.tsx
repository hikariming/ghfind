/* eslint-disable @next/next/no-html-link-for-pages -- these readable aliases and machine-readable docs are same-origin public resources, not locale-routed page transitions. */
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowDownToLine, ArrowUpRight, BookOpen, Braces, KeyRound, Terminal } from "lucide-react";
import { ApiTokenManager } from "@/components/integrations/ApiTokenManager";
import { InstallCommand } from "@/components/integrations/InstallCommand";
import { auth } from "@/lib/auth";
import { localeAlternates } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "integrations" });
  return { title: t("title"), description: t("subtitle"), alternates: localeAlternates(locale, "/integrations") };
}

export default async function IntegrationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, session] = await Promise.all([getTranslations("integrations"), auth()]);
  const command = "curl -fsSL https://ghfind.com/install.sh | bash";

  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
    <header className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-400">{t("eyebrow")}</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">{t("title")}</h1>
      <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">{t("subtitle")}</p>
    </header>

    <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
      <div className="flex items-start gap-3"><span className="mt-0.5 rounded-lg bg-muted p-2"><Terminal size={19} /></span><div><h2 className="text-lg font-semibold">{t("install.heading")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("install.description")}</p></div></div>
      <div className="mt-5 flex flex-col gap-3 rounded-xl bg-[#171717] p-3 text-white sm:flex-row sm:items-center sm:justify-between sm:p-4 dark:bg-[#101010]"><code className="min-w-0 break-all text-xs leading-6 sm:text-sm">{command}</code><InstallCommand command={command} label={t("install.copy")} copiedLabel={t("install.copied")} /></div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("install.requirement")}</p>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm"><a className="inline-flex items-center gap-1.5 underline decoration-border underline-offset-4 hover:text-foreground" href="/cli"><BookOpen size={15} />{t("install.cliDocs")}<ArrowUpRight size={13} /></a><a className="inline-flex items-center gap-1.5 underline decoration-border underline-offset-4 hover:text-foreground" href="/skill"><Braces size={15} />{t("install.skill")}<ArrowUpRight size={13} /></a></div>
    </section>

    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <div className="flex items-center gap-2"><ArrowDownToLine size={18} className="text-emerald-700 dark:text-emerald-400" /><h2 className="text-lg font-semibold">{t("how.heading")}</h2></div>
        <ol className="mt-5 space-y-5">{(["install", "skill", "auth"] as const).map((key, index) => <li key={key} className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{index + 1}</span><p className="text-sm leading-6 text-muted-foreground">{t(`how.${key}`)}</p></li>)}</ol>
      </section>
      <ApiTokenManager signedIn={Boolean(session)} locale={locale} />
    </div>

    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-2"><KeyRound size={18} className="text-emerald-700 dark:text-emerald-400" /><h2 className="text-lg font-semibold">{t("auth.heading")}</h2></div>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t("auth.description")}</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2"><div className="rounded-lg bg-muted/60 p-4"><strong className="text-sm">{t("auth.publicTitle")}</strong><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("auth.public")}</p></div><div className="rounded-lg bg-muted/60 p-4"><strong className="text-sm">{t("auth.protectedTitle")}</strong><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("auth.protected")}</p></div></div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("auth.credentialNote")}</p>
      <div className="mt-4 flex flex-wrap gap-4 text-sm"><a className="inline-flex items-center gap-1 underline decoration-border underline-offset-4" href="/docs">{t("auth.apiDocs")}<ArrowUpRight size={13} /></a><a className="inline-flex items-center gap-1 underline decoration-border underline-offset-4" href="/openapi.json">OpenAPI<ArrowUpRight size={13} /></a><a className="inline-flex items-center gap-1 underline decoration-border underline-offset-4" href="/mcp">MCP<ArrowUpRight size={13} /></a></div>
    </section>
  </main>;
}
