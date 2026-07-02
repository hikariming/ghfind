"use client";

import { DIMENSIONS } from "@/lib/dimensions";
import { SUBSCORE_MAX } from "@/lib/score";
import { TIER_KEY } from "@/lib/tier";
import type { SubScoreKey, SubScores, Tier } from "@/lib/types";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
} from "recharts";

interface DimensionStarChartProps {
  scores: SubScores;
  labels: Record<SubScoreKey, string>;
  tier?: Tier;
  animate?: boolean;
}

interface DimensionDatum {
  key: SubScoreKey;
  label: string;
  value: number;
  max: number;
  pct: number;
  scoreLabel: string;
}

interface AxisTickPayload {
  value?: unknown;
}

interface AxisTickProps {
  x?: number | string;
  y?: number | string;
  index?: number;
  payload?: AxisTickPayload;
}

const SCORE_DOMAIN = [0, 100] as const;
const CHART_MARGIN = { top: 60, right: 92, bottom: 60, left: 92 };

function clampPct(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatScore(value: number, max: number): string {
  return `${value.toFixed(1)} / ${max}`;
}

function splitLabel(label: string): string[] {
  const trimmed = label.trim();
  if (!trimmed) return [""];

  if (trimmed.includes("/")) {
    const [first, ...rest] = trimmed.split("/");
    const second = rest.join("/");
    return second ? [`${first}/`, second] : [trimmed];
  }

  if (/[\s-]/.test(trimmed) && trimmed.length > 16) {
    const words = trimmed.split(/(\s+|-)/).filter(Boolean);
    const midpoint = Math.ceil(words.length / 2);
    const first = words.slice(0, midpoint).join("").trim();
    const second = words.slice(midpoint).join("").trim();
    return second ? [first, second] : [trimmed];
  }

  return [trimmed];
}

function coerceNumber(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function tickAnchor(index: number): "start" | "middle" | "end" {
  if (index === 1 || index === 2) return "start";
  if (index === 4 || index === 5) return "end";
  return "middle";
}

function tickDy(index: number, lineCount: number): number {
  if (index === 0) return -8 - lineCount * 3;
  if (index === 3) return 12;
  return 4;
}

function isTickProps(props: unknown): props is AxisTickProps {
  if (!props || typeof props !== "object") return false;
  return "payload" in props || "x" in props || "y" in props;
}

export function DimensionStarChart({
  scores,
  labels,
  tier,
  animate = true,
}: DimensionStarChartProps) {
  const data: DimensionDatum[] = DIMENSIONS.map((key) => {
    const max = SUBSCORE_MAX[key];
    const value = scores[key] ?? 0;
    const pct = clampPct(value / max);
    return {
      key,
      label: labels[key],
      value,
      max,
      pct: pct * 100,
      scoreLabel: formatScore(value, max),
    };
  });

  const chartKey = data
    .map((dimension) => `${dimension.key}:${dimension.value.toFixed(2)}`)
    .join("|");
  const ariaLabel = data
    .map((dimension) => `${dimension.label} ${dimension.scoreLabel}`)
    .join(", ");
  const toneKey = tier ? TIER_KEY[tier] : "brand";

  const renderTick = (rawProps: unknown) => {
    if (!isTickProps(rawProps)) return <g />;
    const x = coerceNumber(rawProps.x);
    const y = coerceNumber(rawProps.y);
    if (x === null || y === null) return <g />;

    const key = rawProps.payload?.value;
    const dimension =
      typeof key === "string"
        ? data.find((item) => item.key === key)
        : typeof rawProps.index === "number"
          ? data[rawProps.index]
          : undefined;
    if (!dimension) return <g />;

    const index = data.findIndex((item) => item.key === dimension.key);
    const labelLines = splitLabel(dimension.label).slice(0, 2);
    const textAnchor = tickAnchor(index);
    const labelDy = tickDy(index, labelLines.length);

    return (
      <g transform={`translate(${x}, ${y})`}>
        <text
          textAnchor={textAnchor}
          dominantBaseline="middle"
          className="dimension-star-radar-label"
        >
          {labelLines.map((line, lineIndex) => (
            <tspan key={line} x="0" dy={lineIndex === 0 ? labelDy : 16}>
              {line}
            </tspan>
          ))}
          <tspan
            x="0"
            dy="17"
            className="dimension-star-radar-score"
          >
            {dimension.scoreLabel}
          </tspan>
        </text>
      </g>
    );
  };

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-tone={toneKey}
      className="dimension-star-radar mx-auto h-[23rem] w-full max-w-3xl sm:h-[26rem]"
    >
      <RadarChart
        responsive
        data={data}
        margin={CHART_MARGIN}
        style={{ width: "100%", height: "100%" }}
      >
        <PolarGrid
          gridType="polygon"
          radialLines
          stroke="var(--border-soft)"
          strokeWidth={1}
          fill="var(--surface)"
          fillOpacity={0.32}
        />
        <PolarAngleAxis
          dataKey="key"
          axisLine={false}
          tick={renderTick}
          tickLine={false}
          tickSize={22}
        />
        <PolarRadiusAxis
          angle={90}
          domain={SCORE_DOMAIN}
          axisLine={false}
          tick={false}
          tickCount={5}
        />
        <Radar
          key={animate ? chartKey : "dimension-star-radar"}
          dataKey="pct"
          stroke="#f97316"
          fill="rgba(249, 115, 22, 0.16)"
          fillOpacity={1}
          strokeWidth={3}
          dot={{
            r: 5.5,
            fill: "#f97316",
            stroke: "var(--background)",
            strokeWidth: 2,
            className: animate ? "dimension-star-radar-dot" : undefined,
          }}
          isAnimationActive={animate ? "auto" : false}
          animationBegin={0}
          animationDuration={760}
          animationEasing="ease"
        />
      </RadarChart>
    </div>
  );
}
