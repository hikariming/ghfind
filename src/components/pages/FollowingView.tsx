import { FollowingBoard } from "@/components/FollowingBoard";
import type { Translator } from "@/lib/translator";

/** Body of the /following page, shared by the Next app and apps/web (see BlogViews). */
export function FollowingView({ t }: { t: Translator }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 py-14 sm:py-20">
      <header className="mb-8">
        <h1 className="flex items-baseline gap-2 text-2xl font-black tracking-tight text-zinc-100">
          👀 {t("pageTitle")}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">{t("pageSubtitle")}</p>
      </header>
      <FollowingBoard />
    </main>
  );
}
