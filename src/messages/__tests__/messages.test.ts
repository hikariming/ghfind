import { describe, expect, it } from "vitest";
import en from "../en.json";
import zh from "../zh.json";

type Msgs = Record<string, unknown>;

/** Flatten a nested message object into dotted leaf paths. */
function keyPaths(obj: Msgs, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v)
      ? keyPaths(v as Msgs, path)
      : [path];
  });
}

function leaf(obj: Msgs, path: string): unknown {
  return path.split(".").reduce<unknown>((o, p) => (o as Msgs)?.[p], obj);
}

describe("messages parity", () => {
  it("en.json and zh.json have identical key structures", () => {
    const enKeys = keyPaths(en as Msgs).sort();
    const zhKeys = keyPaths(zh as Msgs).sort();
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    expect(missingInEn, `missing in en.json: ${missingInEn.join(", ")}`).toEqual([]);
    expect(missingInZh, `missing in zh.json: ${missingInZh.join(", ")}`).toEqual([]);
  });

  it("has no empty string values in either locale", () => {
    for (const [name, msgs] of [["en", en], ["zh", zh]] as const) {
      const empties = keyPaths(msgs as Msgs).filter((path) => {
        const val = leaf(msgs as Msgs, path);
        return typeof val === "string" && val.trim() === "";
      });
      expect(empties, `empty in ${name}.json: ${empties.join(", ")}`).toEqual([]);
    }
  });
});
