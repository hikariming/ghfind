import { describe, expect, it } from "vitest";
import { routing } from "../../i18n/routing";
import en from "../en.json";
import zh from "../zh.json";
import ja from "../ja.json";
import ko from "../ko.json";
import es from "../es.json";
import pt from "../pt.json";
import id from "../id.json";
import vi from "../vi.json";
import ar from "../ar.json";

type Msgs = Record<string, unknown>;

const ALL: Record<string, Msgs> = { en, zh, ja, ko, es, pt, id, vi, ar };

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
  it("ships a messages file for every routing locale", () => {
    for (const locale of routing.locales) {
      expect(ALL[locale], `missing src/messages/${locale}.json`).toBeDefined();
    }
  });

  it("every locale has the same key structure as en.json", () => {
    const enKeys = keyPaths(en as Msgs).sort();
    for (const [name, msgs] of Object.entries(ALL)) {
      if (name === "en") continue;
      const keys = keyPaths(msgs).sort();
      const missing = enKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !enKeys.includes(k));
      expect(missing, `missing in ${name}.json: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `extra in ${name}.json: ${extra.join(", ")}`).toEqual([]);
    }
  });

  it("has no empty string values in any locale", () => {
    for (const [name, msgs] of Object.entries(ALL)) {
      const empties = keyPaths(msgs).filter((path) => {
        const val = leaf(msgs, path);
        return typeof val === "string" && val.trim() === "";
      });
      expect(empties, `empty in ${name}.json: ${empties.join(", ")}`).toEqual([]);
    }
  });

  it("never introduces an ICU placeholder en.json doesn't define", () => {
    // A translation that INTRODUCES a placeholder en.json lacks crashes at render
    // time (next-intl throws on an unknown arg). The reverse — omitting one en
    // defines — is safe (the surplus arg is ignored) and is sometimes deliberate:
    // e.g. zh states a fixed "<1%" where en interpolates {share}. So we assert
    // each locale's placeholders are a SUBSET of en's, catching the crash case
    // without flagging intentional fixed phrasings.
    const holes = (s: string) => new Set(s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []);
    for (const path of keyPaths(en as Msgs)) {
      const source = leaf(en as Msgs, path);
      if (typeof source !== "string") continue;
      const allowed = holes(source);
      for (const [name, msgs] of Object.entries(ALL)) {
        if (name === "en") continue;
        const val = leaf(msgs, path);
        if (typeof val !== "string") continue;
        const extra = [...holes(val)].filter((h) => !allowed.has(h));
        expect(
          extra,
          `${name}.json ${path}: placeholders not defined in en.json: ${extra.join(", ")}`,
        ).toEqual([]);
      }
    }
  });

  it("includes labels and states for every profile reaction", () => {
    const required = [
      "reactions.heading",
      "reactions.hint",
      "reactions.loginRequired",
      "reactions.loginAction",
      "reactions.failed",
      "reactions.like",
      "reactions.poop",
      "reactions.kick",
      "reactions.fire",
      "reactions.salute",
      "reactions.clown",
    ];
    for (const messages of Object.values(ALL)) {
      expect(required.every((path) => typeof leaf(messages, path) === "string")).toBe(
        true,
      );
    }
  });
});
