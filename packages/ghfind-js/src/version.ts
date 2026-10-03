// Abbreviated tags (1 and 1.2) remain supported. Build metadata has no precedence.
const RELEASE_VERSION = /^(?:ghfind\s*)?[vV]?([0-9]+(?:\.[0-9]+){0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const numeric = (value: string) => /^[0-9]+$/.test(value);

function parseVersion(raw: string | undefined) {
  const match = RELEASE_VERSION.exec((raw ?? "").trim());
  if (!match) return null;
  const core = match[1].split(".");
  const pre = match[2]?.split(".") ?? [];
  if ([...core, ...pre.filter(numeric)].some((part) => part.length > 1 && part[0] === "0")) return null;
  while (core.length < 3) core.push("0");
  return { core, pre };
}

// Comparing lengths first keeps numeric identifiers exact beyond Number.MAX_SAFE_INTEGER.
function compareNumeric(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function isNewerVersion(latest: string | undefined, current: string): { newer: boolean; comparable: boolean } {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return { newer: false, comparable: false };
  for (let i = 0; i < 3; i++) {
    const cmp = compareNumeric(l.core[i], c.core[i]);
    if (cmp) return { newer: cmp > 0, comparable: true };
  }
  if (!l.pre.length || !c.pre.length) {
    return { newer: !l.pre.length && c.pre.length > 0, comparable: true };
  }
  for (let i = 0; i < Math.min(l.pre.length, c.pre.length); i++) {
    const a = l.pre[i], b = c.pre[i];
    const an = numeric(a), bn = numeric(b);
    if (an !== bn) return { newer: !an, comparable: true };
    const cmp = an ? compareNumeric(a, b) : a < b ? -1 : a > b ? 1 : 0;
    if (cmp) return { newer: cmp > 0, comparable: true };
  }
  return { newer: l.pre.length > c.pre.length, comparable: true };
}
