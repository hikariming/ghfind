import { SITE_URL } from "@/lib/site";
import type { Translator } from "@/lib/translator";

/**
 * Human-readable developer docs. The machine surfaces (openapi.json, llms.txt,
 * auth.md) already exist for agents that know the URLs — this HTML page is what
 * search engines index, so a "ghfind API" query can find the resources by name.
 */

type Endpoint = { sig: string; desc: string };
type Tool = { name: string; desc: string };
type Sdk = { name: string; desc: string };
type MachineLink = { label: string; desc: string };

/** Body of the /docs page, shared by the Next app and apps/web (see BlogViews). */
export function DocsView({ t }: { t: Translator }) {
  const endpoints = t.raw("endpoints") as Endpoint[];
  const tools = t.raw("tools") as Tool[];
  const sdks = t.raw("sdks") as Sdk[];
  const machine = t.raw("machine") as MachineLink[];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-14 sm:py-20">
      <h1 className="text-3xl font-black tracking-tight text-[var(--foreground)] sm:text-5xl">
        {t("heading")}
      </h1>
      <p className="mt-6 text-lg leading-relaxed text-zinc-300">{t("lead")}</p>

      <section className="mt-12">
        <h2 className="text-2xl font-bold text-[var(--foreground)]">{t("restHeading")}</h2>
        <p className="mt-3 text-base leading-relaxed text-zinc-400">{t("restIntro")}</p>
        <dl className="mt-6 flex flex-col gap-4">
          {endpoints.map((e) => (
            <div
              key={e.sig}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            >
              <dt>
                <code className="font-bold text-[var(--foreground)]">{e.sig}</code>
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-zinc-400">{e.desc}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold text-[var(--foreground)]">{t("mcpHeading")}</h2>
        <p className="mt-3 text-base leading-relaxed text-zinc-400">{t("mcpIntro")}</p>
        <ul className="mt-6 flex flex-col gap-3">
          {tools.map((tool) => (
            <li key={tool.name} className="text-sm leading-relaxed text-zinc-400">
              <code className="font-bold text-[var(--foreground)]">{tool.name}</code>
              {" — "}
              {tool.desc}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold text-[var(--foreground)]">{t("authHeading")}</h2>
        <p className="mt-3 text-base leading-relaxed text-zinc-400">{t("authBody")}</p>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold text-[var(--foreground)]">{t("sdkHeading")}</h2>
        <ul className="mt-6 flex flex-col gap-3">
          {sdks.map((sdk) => (
            <li key={sdk.name} className="text-sm leading-relaxed text-zinc-400">
              <code className="font-bold text-[var(--foreground)]">{sdk.name}</code>
              {" — "}
              {sdk.desc}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold text-[var(--foreground)]">{t("machineHeading")}</h2>
        <ul className="mt-6 flex flex-col gap-3">
          {machine.map((m) => (
            <li key={m.label} className="text-sm leading-relaxed text-zinc-400">
              <a
                href={`${SITE_URL}${m.label.split(" ")[0]}`}
                className="font-bold text-[var(--primary)] hover:underline"
              >
                <code>{m.label}</code>
              </a>
              {" — "}
              {m.desc}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
