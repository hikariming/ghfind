/**
 * Parity check of the collector classifiers (src/lib/devscore/collect/classify.ts) against
 * devscore's collect.py on a corpus of real inputs.
 *
 *   python3 scripts/devscore-classify-corpus.py <devscore dir> > /tmp/corpus.json
 *   pnpm tsx scripts/devscore-classify-parity.mts /tmp/corpus.json
 *
 * The corpus holds [collect.py function, args, output] cases; every TS function must return
 * the same JSON (numbers within 1e-12). Exits 1 on any mismatch.
 */
import { readFileSync } from "node:fs";
import { CLASSIFY_CASES, runClassifyCase } from "../src/lib/devscore/collect/__tests__/classify-cases";

const corpus = JSON.parse(readFileSync(process.argv[2], "utf8")) as { cases: [string, unknown[], unknown][] };
const perFn = new Map<string, { n: number; bad: number }>();
let bad = 0;
for (const [fn, args, want] of corpus.cases) {
  if (!(fn in CLASSIFY_CASES)) throw new Error(`no TS counterpart for ${fn}`);
  const s = perFn.get(fn) ?? { n: 0, bad: 0 };
  perFn.set(fn, s);
  s.n++;
  const diff = runClassifyCase(fn, args, want);
  if (diff) {
    s.bad++;
    if (bad++ < 30) console.log(`MISMATCH ${fn}(${JSON.stringify(args).slice(0, 300)}): ${diff}`);
  }
}
for (const [fn, s] of [...perFn].sort()) console.log(`${fn.padEnd(26)} ${String(s.n).padStart(6)} cases  ${s.bad} mismatches`);
console.log(`${corpus.cases.length} cases, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
