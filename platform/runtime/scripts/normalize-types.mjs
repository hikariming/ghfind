// Wrangler runtime declarations currently contain upstream trailing whitespace.
// Keep generated types reproducible while allowing repository whitespace checks.
import { readFileSync, writeFileSync } from "node:fs";
const path = new URL("../worker-configuration.d.ts", import.meta.url);
writeFileSync(path, readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""));
