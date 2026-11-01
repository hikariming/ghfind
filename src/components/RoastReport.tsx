"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rewriteLegacyRoastMarkdown } from "@/lib/roast-report-legacy";
import { TIER_KEY } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import { realmForScore, realmForTier, remapRoastHeaderLine } from "@/lib/realm";

/**
 * Profile / live / modal roast markdown — compact v13n card layout:
 * - blockquote → tier-tinted left-border verdict callout
 * - dimension h4+note pairs → 2-col grid of cards (1-col mobile) with
 *   tier-colored score + 3px bar
 * - ol/li with leading **title** → numbered chip inline with title+body
 * - ul → compact advice bullets with tier markers
 * - "风险标记：无" stays a single inline line (no section)
 *
 * Tier accents use CSS vars on [data-tier-tone] (see globals.css) so Tailwind
 * purge cannot drop them. Legacy cached markdown is rewritten first.
 */
const DIM_SCORE_RE = /^(.+?)\s*[·•|]\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/;
const DIM_SECTION_RE = /^###\s*(维度评分|Dimensions)\s*$/m;
const NEXT_H3_RE = /^###\s+/m;
/** End the dims block before an inline risk line or the next section heading. */
const DIM_SECTION_END_RE = /^(?:###\s+|\*\*(?:风险标记|Red flags|建议|Next)(?:\*\*)?[：:\s])/m;

/** Legacy + current markdown verdict headings remapped to the active UI locale. */
const VERDICT_LABEL_RE = /\*\*(一句话结论|一句话总结|小总评|TL;DR|Quick Verdict)\*\*/g;

function localizeVerdictLabel(md: string, label: string): string {
  return md.replace(VERDICT_LABEL_RE, `**${label}**`);
}


type DimCard = { name: string; score: number; max: number; note: string };

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node && "props" in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/**
 * Resolve the HTML tag for a react-markdown child.
 * Prefer the host string type, then hast `props.node.tagName`, then an explicit
 * `displayName` we set on custom components. Never use `function.name` — production
 * minifiers rewrite it and would silently drop finding chips.
 */
function elementTag(node: ReactNode): string | null {
  if (!node || typeof node !== "object" || !("type" in node)) return null;
  const el = node as {
    type?: unknown;
    props?: { node?: { tagName?: string }; children?: ReactNode };
  };
  if (typeof el.type === "string") return el.type;
  const hast = el.props?.node?.tagName;
  if (typeof hast === "string" && hast) return hast;
  if (typeof el.type === "function") {
    const dn = (el.type as { displayName?: string }).displayName;
    if (typeof dn === "string" && dn) return dn;
  }
  return null;
}

/** Exported for unit tests that simulate minified component function names. */
export { elementTag };

function skipBlank(nodes: ReactNode[]): ReactNode[] {
  const arr = [...nodes];
  while (arr.length && (arr[0] == null || arr[0] === "" || arr[0] === "\n" || arr[0] === " ")) {
    arr.shift();
  }
  return arr;
}

/**
 * Finding lines are `1. **title**\n\n   body` (loose list) → <li><p><strong>title</strong></p><p>body</p></li>,
 * or tight `1. **title** body` → <li><strong>title</strong> body</li>.
 * Custom `strong`/`p` components make `type` a function, so match via hast tagName / displayName.
 */
function splitLeadingStrong(children: ReactNode): { chip: ReactNode | null; rest: ReactNode } {
  const arr = skipBlank(Array.isArray(children) ? children : [children]);
  const first = arr[0];
  // Tight list: leading **title**
  if (elementTag(first) === "strong") {
    return {
      chip: (first as { props?: { children?: ReactNode } }).props?.children ?? null,
      rest: arr.slice(1),
    };
  }
  // Loose list: title-only <p><strong>…</strong></p> then body paragraphs
  if (elementTag(first) === "p") {
    const pChildren = (first as { props?: { children?: ReactNode } }).props?.children;
    const inner = skipBlank(Array.isArray(pChildren) ? pChildren : [pChildren]);
    const lead = inner[0];
    if (elementTag(lead) === "strong" && inner.length === 1) {
      return {
        chip: (lead as { props?: { children?: ReactNode } }).props?.children ?? null,
        rest: arr.slice(1),
      };
    }
  }
  return { chip: null, rest: children };
}

/** Pull #### Name · score/max + following note paragraphs out of the dims section. */
function splitDimensionSection(md: string): { before: string; dims: DimCard[]; after: string } {
  const sectionMatch = md.match(DIM_SECTION_RE);
  if (!sectionMatch || sectionMatch.index == null) {
    return { before: md, dims: [], after: "" };
  }
  const sectionStart = sectionMatch.index;
  const bodyStart = sectionStart + sectionMatch[0].length;
  const rest = md.slice(bodyStart);
  // Stop at next ### OR an inline **风险标记**/**建议** that render.ts emits
  // when there is nothing to flag — otherwise those lines stick to the last
  // dimension note as raw markdown asterisks.
  const next = rest.search(DIM_SECTION_END_RE);
  const dimBody = (next < 0 ? rest : rest.slice(0, next)).trim();
  const after = next < 0 ? "" : rest.slice(next);
  const before = md.slice(0, sectionStart).trimEnd();

  const dims: DimCard[] = [];
  const blocks = dimBody.split(/^####\s+/m).filter((b) => b.trim());
  for (const block of blocks) {
    const nl = block.indexOf("\n");
    const head = (nl < 0 ? block : block.slice(0, nl)).trim();
    const note = (nl < 0 ? "" : block.slice(nl + 1)).trim();
    const m = head.match(DIM_SCORE_RE);
    if (!m) continue;
    dims.push({
      name: m[1].trim(),
      score: Number(m[2]),
      max: Number(m[3]),
      note: note
        .replace(/^>\s?/gm, "")
        .replace(/\n\n\*\*(?:风险标记|Red flags)\*\*[：:][\s\S]*$/, "")
        .trim(),
    });
  }
  return { before, dims, after };
}

/** Collapse "### 风险标记\n\n无。" into a single inline paragraph. */
function collapseEmptyRisk(md: string): string {
  return md
    .replace(
      /^\*\*(风险标记|Red flags)\*\*\s*\n+(?:[-*]\s*)?(无。?|None\.?)\s*$/gim,
      (_m, label: string, none: string) => {
        const zh = /风险/.test(label);
        const bare = none.replace(/[。.]$/, "");
        return zh ? `**风险标记**：${bare}` : `**Red flags**: ${bare}`;
      },
    )
    .replace(
      /^\*\*(风险标记|Red flags)\*\*\s*\n+(?:[-*]\s*)?(无。?|None\.?)\s*\n+/gim,
      (_m, label: string, none: string) => {
        const zh = /风险/.test(label);
        const bare = none.replace(/[。.]$/, "");
        return zh ? `**风险标记**：${bare}\n\n` : `**Red flags**: ${bare}\n\n`;
      },
    )
    .replace(
      /^###\s*(风险标记|Red flags)\s*\n+(?:[-*]\s*)?(无。?|None\.?)\s*$/gim,
      (_m, label: string, none: string) => {
        const zh = /风险/.test(label);
        const bare = none.replace(/[。.]$/, "");
        return zh ? `**风险标记**：${bare}` : `**Red flags**: ${bare}`;
      },
    )
    .replace(
      /^###\s*(风险标记|Red flags)\s*\n+(?:[-*]\s*)?(无。?|None\.?)\s*\n+/gim,
      (_m, label: string, none: string) => {
        const zh = /风险/.test(label);
        const bare = none.replace(/[。.]$/, "");
        return zh ? `**风险标记**：${bare}\n\n` : `**Red flags**: ${bare}\n\n`;
      },
    );
}

function DimCardView({ name, score, max, note }: DimCard) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (score / max) * 100)) : 0;
  const scoreLabel = Number.isInteger(score) ? String(score) : score.toFixed(1);
  return (
    <article className="roast-dim-card">
      <div className="roast-dim-head">
        <span className="roast-dim-name">{name}</span>
        <span className="roast-dim-score">
          {scoreLabel}/{max}
        </span>
      </div>
      <div
        className="roast-dim-bar"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${name} ${pct.toFixed(0)}%`}
      >
        <div className="roast-dim-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {note ? <p className="roast-dim-note">{note}</p> : null}
    </article>
  );
}

type MdProps = { children?: ReactNode; href?: string; className?: string };

function RoastP({ children }: MdProps) {
  const raw = textOf(children).trim();
  if (/^(风险标记|Red flags)\s*[:：]/.test(raw) && /(?:无|None)\s*$/.test(raw)) {
    return <p className="roast-risk-inline">{children}</p>;
  }
  return <p className="roast-p">{children}</p>;
}
RoastP.displayName = "p";

function RoastStrong({ children }: MdProps) {
  return <strong className="roast-strong">{children}</strong>;
}
RoastStrong.displayName = "strong";

function makeComponents(): Components {
  return {
    h1: ({ children }) => <h1 className="roast-h1">{children}</h1>,
    h2: ({ children }) => <h2 className="roast-h2">{children}</h2>,
    h3: ({ children }) => {
      const raw = textOf(children).trim();
      // Hide empty "维度评分" heading — grid has its own visual weight.
      if (/^(维度评分|Dimensions)$/.test(raw)) return null;
      return <h3 className="roast-h3">{children}</h3>;
    },
    h4: ({ children }) => {
      // Dimension h4s are extracted; leftover h4s render plain.
      return <h4 className="roast-h4">{children}</h4>;
    },
    p: RoastP,
    blockquote: ({ children }) => (
      <blockquote className="roast-verdict not-italic">{children}</blockquote>
    ),
    ul: ({ children }) => <ul className="roast-advice">{children}</ul>,
    ol: ({ children }) => <ol className="roast-findings">{children}</ol>,
    li: ({ children }) => {
      const { chip, rest } = splitLeadingStrong(children);
      if (chip) {
        return (
          <li className="roast-finding">
            <span className="roast-finding-num" aria-hidden />
            <div className="roast-finding-body">
              <strong className="roast-finding-title">{chip}</strong>
              <span className="roast-finding-text">{rest}</span>
            </div>
          </li>
        );
      }
      return <li>{children}</li>;
    },
    strong: RoastStrong,
    a: ({ children, href }) => (
      <a href={href} className="roast-a">
        {children}
      </a>
    ),
    code: ({ children, className }) =>
      className ? (
        <code className={className}>{children}</code>
      ) : (
        <code className="roast-code">{children}</code>
      ),
    table: ({ children }) => <table className="roast-table">{children}</table>,
    th: ({ children }) => <th className="roast-th">{children}</th>,
    td: ({ children }) => <td className="roast-td">{children}</td>,
    hr: () => <hr className="roast-hr" />,
  };
}

const components = makeComponents();

export function RoastReport({
  markdown,
  className = "",
  tier,
  score,
  realmName,
}: {
  markdown: string;
  className?: string;
  /** Stored tier — fallback for accents when score is missing. */
  tier?: Tier | null;
  /** Numeric score — preferred for realm accents + header Lv remap. */
  score?: number | null;
  /** Localized realm display name for header remap. */
  realmName?: string | null;
}) {
  const t = useTranslations("detail");
  const verdictLabel = t("verdictLabel");
  const realm =
    typeof score === "number"
      ? realmForScore(score)
      : tier
        ? realmForTier(tier)
        : null;
  const tone = realm?.id ?? (tier ? TIER_KEY[tier] : "elite");
  const { before, dims, after } = useMemo(() => {
    let md = rewriteLegacyRoastMarkdown(markdown ?? "");
    if (typeof score === "number" && realmName) {
      md = remapRoastHeaderLine(md, score, realmName);
    }
    const rewritten = localizeVerdictLabel(collapseEmptyRisk(md), verdictLabel);
    return splitDimensionSection(rewritten);
  }, [markdown, verdictLabel, score, realmName]);

  return (
    <div
      dir="ltr"
      data-tier-tone={tier ? TIER_KEY[tier] : "elite"}
      data-realm-tone={realm?.id}
      className={`report roast-report ${className}`.trim()}
    >
      {before ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {before}
        </ReactMarkdown>
      ) : null}
      {dims.length > 0 ? (
        <section className="roast-dims" aria-label="维度评分">
          {dims.map((d) => (
            <DimCardView key={d.name} {...d} />
          ))}
        </section>
      ) : null}
      {after ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {after}
        </ReactMarkdown>
      ) : null}
    </div>
  );
}
