/**
 * Print the Talent Match role-family benchmark (top-1 / top-3 family hit
 * rate, must-not violation rate, each login's top jobs).
 *
 *   node --import tsx scripts/talent-match-bench.mts
 */
import { runBench } from "../src/lib/talent-match/__tests__/bench/bench";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const { rows, top1, top3, violationRate } = runBench();
for (const row of rows) {
  const mark = `${row.top1Hit ? "1" : "-"}${row.top3Hit ? "3" : "-"}${row.violations.length ? "!" : " "}`;
  const top = row.top.map((t) => `${t.id}(${t.family},${t.fit})`).join("  ");
  console.log(`${mark} ${row.login.padEnd(17)} [${row.expect.join("/")}]  ${top}`);
}
console.log(`\ntop-1 hit ${pct(top1)} · top-3 hit ${pct(top3)} · must-not violation (top-3) ${pct(violationRate)} · n=${rows.length}`);
