import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PoweredByLobeHub } from "@/components/Sponsor";

const REPO_URL = "https://github.com/hikariming/ghfind";

/**
 * Global footer. Beyond the sponsor credit, it surfaces the trust-anchor pages
 * (About / Contact / Privacy / Methodology) — the pages AI agents check to verify
 * a business is legitimate — as real internal links on every page.
 */
export async function SiteFooter() {
  const t = await getTranslations("footer");
  const tNav = await getTranslations("nav");

  const product = [
    { label: tNav("leaderboard"), href: "/leaderboard" },
    { label: tNav("developers"), href: "/developers" },
    { label: tNav("versus"), href: "/vs" },
    { label: t("blog"), href: "/blog" },
  ];
  const resources = [
    { label: t("docs"), href: "/docs" },
    { label: t("methodology"), href: "/methodology" },
    { label: "API", href: "/openapi.json", external: true },
    { label: "llms.txt", href: "/llms.txt", external: true },
  ];
  const company = [
    { label: t("about"), href: "/about" },
    { label: t("contact"), href: "/contact" },
    { label: t("privacy"), href: "/privacy" },
  ];

  return (
    <footer className="site-footer mt-auto w-full border-t border-[var(--border)] px-5 py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <div className="text-lg font-black text-[var(--foreground)]">ghfind</div>
            <p className="mt-2 text-sm text-zinc-500">{t("tagline")}</p>
          </div>
          <FooterCol title={t("sectionProduct")}>
            {product.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="hover:text-[var(--primary)]">
                  {l.label}
                </Link>
              </li>
            ))}
          </FooterCol>
          <FooterCol title={t("sectionResources")}>
            {resources.map((l) => (
              <li key={l.href}>
                {l.external ? (
                  <a href={l.href} className="hover:text-[var(--primary)]" rel="noopener">
                    {l.label}
                  </a>
                ) : (
                  <Link href={l.href} className="hover:text-[var(--primary)]">
                    {l.label}
                  </Link>
                )}
              </li>
            ))}
            <li>
              <a href={REPO_URL} className="hover:text-[var(--primary)]" rel="noopener" target="_blank">
                {t("source")}
              </a>
            </li>
          </FooterCol>
          <FooterCol title={t("sectionCompany")}>
            {company.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="hover:text-[var(--primary)]">
                  {l.label}
                </Link>
              </li>
            ))}
          </FooterCol>
        </div>
        <div className="flex justify-center border-t border-[var(--border)] pt-6">
          <PoweredByLobeHub />
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      <ul className="mt-3 flex flex-col gap-2 text-sm text-zinc-400">{children}</ul>
    </div>
  );
}
