import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { authConfigured } from "@/lib/auth";
import { NAV_ITEMS } from "@/config/nav";
import { NavLinks } from "./NavLinks";
import { NavAuth } from "./NavAuth";
import { MobileMenu } from "./MobileMenu";
import { BrandMark } from "./BrandMark";
import { GlobalSearch } from "./GlobalSearch";
import { LanguageSwitcher } from "./LanguageSwitcher";

/**
 * Site-wide top bar. Keep the public-site feel: plain brand on the left, normal
 * navigation links in the middle, account/source actions on the right.
 */
export async function Navbar() {
  const tNav = await getTranslations("nav");
  const tRepo = await getTranslations("repoLink");
  const oauthConfigured = authConfigured();
  const repoHref = "https://github.com/hikariming/ghfind";

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/10 bg-white/[0.03] backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-5 sm:px-6">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2.5 text-[1.35rem] font-black leading-none tracking-tight text-zinc-100 transition-colors hover:text-white"
        >
          <BrandMark className="size-7 shrink-0 transition-transform group-hover:rotate-3" />
          {tNav("brand")}
        </Link>

        <div className="hidden min-w-0 flex-1 md:flex">
          <NavLinks items={NAV_ITEMS} />
        </div>

        <div className="ml-auto flex items-center justify-end gap-2">
          <div className="hidden md:block">
            <GlobalSearch />
          </div>
          <div className="hidden items-center gap-2 sm:flex md:gap-1.5">
            {/* Language toggle sits inline next to the avatar box — surfaced
                here rather than buried in the account/settings dropdown so
                visitors can switch locale in one click. Hidden below md to keep
                the smaller navbar from getting crowded. */}
            <div className="hidden md:block">
              <LanguageSwitcher />
            </div>
            <NavAuth
              configured={oauthConfigured}
              repoHref={repoHref}
              repoLabel={tRepo("label")}
              repoTitle={tRepo("title")}
            />
          </div>

          {/* On mobile the locale switcher gets its own always-visible control
              next to the hamburger. Previously it lived only at the bottom of
              the (now long) mobile drawer, where the growing nav pushed it out
              of easy reach. */}
          <div className="md:hidden">
            <LanguageSwitcher />
          </div>

          <div className="md:hidden">
            <MobileMenu configured={oauthConfigured} repoHref={repoHref} />
          </div>
        </div>
      </div>
    </header>
  );
}
