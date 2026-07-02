"use client";

import { Search, X } from "lucide-react";
import { useLocale } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@/i18n/navigation";
import { facetPath } from "@/lib/discovery";
import type { FacetType } from "@/lib/facets";
import type { Tier } from "@/lib/types";
import { loadByoKey } from "@/components/ByoKeyModal";
import { Input } from "@/components/ui/input";

export interface DiscoveryCategory {
  type: FacetType;
  value: string;
  count: number;
  countText: string;
}

export interface DiscoveryPreset {
  id: string;
  label: string;
  query: string;
}

export interface DevelopersDiscoveryLabels {
  searchLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  searchResultsTitle: string;
  browseTitle: string;
  emptySearchResults: string;
  emptyBrowseResults: string;
  aiLoading: string;
  aiFallback: string;
  aiUnavailable: string;
  aiSummaryTitle: string;
  aiDevelopersTitle: string;
  promptTitle: string;
  typeLabels: Record<FacetType, string>;
  languagesTitle: string;
  projectsTitle: string;
  orgsTitle: string;
}

interface AiFacetResult {
  type: FacetType;
  value: string;
  count: number;
  reason?: string;
  href: string;
}

interface AiDeveloperResult {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  matched_facets: { type: FacetType; value: string }[];
}

interface AiSearchResponse {
  mode: "ai" | "fallback";
  error?: string;
  summary?: string;
  facets: AiFacetResult[];
  developers: AiDeveloperResult[];
}

interface DevelopersDiscoveryProps {
  browseCategories: Record<FacetType, DiscoveryCategory[]>;
  searchCategories: Record<FacetType, DiscoveryCategory[]>;
  labels: DevelopersDiscoveryLabels;
  presets: DiscoveryPreset[];
}

const TYPE_ORDER: FacetType[] = ["language", "repo", "org"];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesQuery(item: DiscoveryCategory, typeLabel: string, terms: string[]): boolean {
  const haystack = normalize(`${item.value} ${typeLabel} ${item.type}`);
  return terms.every((term) => haystack.includes(term));
}

function rankMatch(item: DiscoveryCategory, query: string): number {
  const value = normalize(item.value);
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  return 2;
}

function CategoryPill({
  item,
  typeLabel,
  showType,
}: {
  item: DiscoveryCategory;
  typeLabel: string;
  showType?: boolean;
}) {
  return (
    <Link
      href={facetPath(item.type, item.value)}
      className="group flex min-h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm transition-colors hover:border-white/20 hover:bg-white/[0.07]"
    >
      {showType && (
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-zinc-500 group-hover:text-zinc-400">
          {typeLabel}
        </span>
      )}
      <span className="font-semibold text-zinc-100">{item.value}</span>
      <span className="tabular-nums text-xs text-zinc-500 group-hover:text-zinc-400">
        {item.countText}
      </span>
    </Link>
  );
}

function CategorySection({
  title,
  items,
  labels,
}: {
  title: string;
  items: DiscoveryCategory[];
  labels: DevelopersDiscoveryLabels;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-4 text-lg font-black text-zinc-200">{title}</h2>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <CategoryPill
            key={`${item.type}:${item.value}`}
            item={item}
            typeLabel={labels.typeLabels[item.type]}
          />
        ))}
      </div>
    </section>
  );
}

export function DevelopersDiscovery({
  browseCategories,
  searchCategories,
  labels,
  presets,
}: DevelopersDiscoveryProps) {
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [aiResult, setAiResult] = useState<AiSearchResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const normalizedQuery = normalize(query);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  const allCategories = useMemo(
    () => TYPE_ORDER.flatMap((type) => searchCategories[type]),
    [searchCategories],
  );

  const results = useMemo(() => {
    if (terms.length === 0) return [];
    return allCategories
      .filter((item) => matchesQuery(item, labels.typeLabels[item.type], terms))
      .sort((a, b) => {
        const rankDelta = rankMatch(a, normalizedQuery) - rankMatch(b, normalizedQuery);
        if (rankDelta !== 0) return rankDelta;
        if (b.count !== a.count) return b.count - a.count;
        return a.value.localeCompare(b.value);
      })
      .slice(0, 60);
  }, [allCategories, labels.typeLabels, normalizedQuery, terms]);

  const groupedResults = useMemo(
    () =>
      TYPE_ORDER.map((type) => ({
        type,
        items: results.filter((item) => item.type === type),
      })).filter((group) => group.items.length > 0),
    [results],
  );
  const hasBrowseCategories = TYPE_ORDER.some(
    (type) => browseCategories[type].length > 0,
  );

  function updateQuery(next: string) {
    setQuery(next);
    if (!next.trim()) {
      setAiResult(null);
      setAiError(null);
      setAiLoading(false);
    }
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setAiLoading(true);
      setAiError(null);
      fetch("/api/developers/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, lang: locale, byoKey: loadByoKey() }),
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`search_${res.status}`);
          return (await res.json()) as AiSearchResponse;
        })
        .then((data) => {
          setAiResult(data);
          setAiError(data.error ?? null);
        })
        .catch((error: unknown) => {
          if (ctrl.signal.aborted) return;
          setAiResult(null);
          setAiError(error instanceof Error ? error.message : "search_failed");
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setAiLoading(false);
        });
    }, 350);

    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [locale, query]);

  return (
    <div className="flex flex-col gap-10">
      <section className="border-y border-white/10 py-5">
        <label className="block text-sm font-semibold text-zinc-300" htmlFor="developer-tag-search">
          {labels.searchLabel}
        </label>
        <div className="relative mt-3">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500"
          />
          <Input
            id="developer-tag-search"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder={labels.searchPlaceholder}
            className="h-11 rounded-full pl-10 pr-11"
          />
          {query && (
            <button
              type="button"
              aria-label={labels.clearSearch}
              title={labels.clearSearch}
              onClick={() => updateQuery("")}
              className="absolute right-2 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
        <div className="mt-4">
          <h2 className="text-xs font-bold uppercase text-zinc-500">{labels.promptTitle}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => updateQuery(preset.query)}
                className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm font-semibold text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.07] hover:text-zinc-100"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {terms.length > 0 ? (
        <section>
          <h2 className="mb-4 text-lg font-black text-zinc-200">
            {labels.searchResultsTitle}
          </h2>
          {aiLoading && <p className="text-zinc-500">{labels.aiLoading}</p>}
          {aiError === "no_llm_configured" && (
            <p className="mb-4 text-sm text-amber-300">{labels.aiUnavailable}</p>
          )}
          {aiResult?.mode === "fallback" && aiError !== "no_llm_configured" && (
            <p className="mb-4 text-sm text-zinc-500">{labels.aiFallback}</p>
          )}
          {aiResult && (aiResult.facets.length > 0 || aiResult.developers.length > 0) ? (
            <div className="flex flex-col gap-7">
              {(aiResult.summary || aiResult.facets.length > 0) && (
                <div>
                  <h3 className="mb-2 text-sm font-bold text-zinc-500">
                    {labels.aiSummaryTitle}
                  </h3>
                  {aiResult.summary && (
                    <p className="mb-3 max-w-2xl text-sm text-zinc-400">
                      {aiResult.summary}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {aiResult.facets.map((facet) => (
                      <Link
                        key={`${facet.type}:${facet.value}`}
                        href={facet.href}
                        className="group flex min-h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm transition-colors hover:border-white/20 hover:bg-white/[0.07]"
                        title={facet.reason}
                      >
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-zinc-500 group-hover:text-zinc-400">
                          {labels.typeLabels[facet.type]}
                        </span>
                        <span className="font-semibold text-zinc-100">{facet.value}</span>
                        <span className="tabular-nums text-xs text-zinc-500 group-hover:text-zinc-400">
                          {facet.count}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {aiResult.developers.length > 0 && (
                <div>
                  <h3 className="mb-3 text-sm font-bold text-zinc-500">
                    {labels.aiDevelopersTitle}
                  </h3>
                  <ol className="flex flex-col gap-2">
                    {aiResult.developers.map((dev, index) => (
                      <li
                        key={dev.username}
                        className="relative flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 transition-colors hover:bg-white/[0.06]"
                      >
                        <Link
                          href={`/u/${dev.username}`}
                          prefetch={false}
                          className="absolute inset-0 z-0 rounded-xl"
                          aria-label={`@${dev.username}`}
                        />
                        <span className="relative z-10 w-7 text-center text-sm font-bold tabular-nums text-zinc-500">
                          {index + 1}
                        </span>
                        {dev.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={dev.avatar_url}
                            alt={dev.username}
                            className="relative z-10 size-9 rounded-full"
                          />
                        ) : (
                          <div className="relative z-10 size-9 rounded-full bg-white/10" />
                        )}
                        <div className="relative z-10 min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                            <a
                              href={dev.profile_url ?? `https://github.com/${dev.username}`}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate font-semibold text-zinc-100 underline-offset-2 hover:underline"
                            >
                              @{dev.username}
                            </a>
                            {dev.display_name && (
                              <span className="truncate text-sm text-zinc-500">
                                {dev.display_name}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {dev.matched_facets.slice(0, 4).map((facet) => (
                              <span
                                key={`${dev.username}:${facet.type}:${facet.value}`}
                                className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-zinc-400"
                              >
                                {facet.value}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="relative z-10 text-right">
                          <div className="text-xs font-semibold text-zinc-500">Score</div>
                          <div className="font-black tabular-nums text-zinc-100">
                            {dev.final_score.toFixed(2)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          ) : !aiLoading && groupedResults.length > 0 ? (
            <div className="flex flex-col gap-5">
              {groupedResults.map((group) => (
                <div key={group.type}>
                  <h3 className="mb-2 text-sm font-bold text-zinc-500">
                    {labels.typeLabels[group.type]}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {group.items.map((item) => (
                      <CategoryPill
                        key={`${item.type}:${item.value}`}
                        item={item}
                        typeLabel={labels.typeLabels[item.type]}
                        showType={false}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : !aiLoading ? (
            <p className="text-zinc-500">{labels.emptySearchResults}</p>
          ) : null}
        </section>
      ) : (
        <section>
          <h2 className="mb-6 text-lg font-black text-zinc-200">{labels.browseTitle}</h2>
          {hasBrowseCategories ? (
            <div className="flex flex-col gap-10">
              <CategorySection
                title={labels.languagesTitle}
                items={browseCategories.language}
                labels={labels}
              />
              <CategorySection
                title={labels.projectsTitle}
                items={browseCategories.repo}
                labels={labels}
              />
              <CategorySection title={labels.orgsTitle} items={browseCategories.org} labels={labels} />
            </div>
          ) : (
            <p className="text-zinc-500">{labels.emptyBrowseResults}</p>
          )}
        </section>
      )}
    </div>
  );
}
