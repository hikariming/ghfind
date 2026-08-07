import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  currentProjectAnalysisArtifactSchema,
  currentRuntimeEvidenceArtifactSchema,
} from "../src/lib/project-analysis-contract";

const outputDirectory = resolve("skills/ghfind-project-evaluator/schemas");
await mkdir(outputDirectory, { recursive: true });

const schemas = [
  ["project-analysis.schema.json", currentProjectAnalysisArtifactSchema],
  ["runtime-evidence.schema.json", currentRuntimeEvidenceArtifactSchema],
] as const;

for (const [filename, schema] of schemas) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
  await writeFile(
    resolve(outputDirectory, filename),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
    "utf8",
  );
}
