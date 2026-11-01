import { localePath } from "@/lib/site";

/** Read-only recovery page: no score, scan requests, or client hydration. */
export function UnratedProfile({ username, displayName, locale, message, action, github }: {
  username: string; displayName: string | null; locale: string;
  message: string; action: string; github: string;
}) {
  return (
    <main className="flex w-full flex-1 justify-center px-5 py-16 sm:py-24">
      <section className="h-fit w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
        <h1 className="break-words text-2xl font-bold text-zinc-100">{displayName || username}</h1>
        <p className="mt-2 break-all text-sm text-zinc-400">@{username}</p>
        <p className="mt-6 text-base leading-relaxed text-zinc-300">{message}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href={`${localePath(locale, "/")}?username=${encodeURIComponent(username)}`}
            className="inline-flex min-h-11 items-center rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange-400">{action}</a>
          <a href={`https://github.com/${encodeURIComponent(username)}`} rel="noopener noreferrer" target="_blank"
            className="inline-flex min-h-11 items-center rounded-lg px-4 py-2 text-sm text-zinc-300 underline underline-offset-4 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange-400">{github}</a>
        </div>
      </section>
    </main>
  );
}
