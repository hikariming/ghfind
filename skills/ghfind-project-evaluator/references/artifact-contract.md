# Artifact contract

Use UTF-8. Keep JSON machine-readable and Markdown human-readable.

## Analysis JSON

Required top-level fields:

```text
schema_version = ghfind.project-analysis.v2
analysis_id
repository { repo_key, canonical_url, requested_ref, resolved_commit_sha }
rubric_version
agent_version = project-evaluator-v2
skill_version = ghfind-project-evaluator-v3
project { name, summary, target_users[], pain_statement, project_type, lifecycle, product_tags[] }
scores { pain, effectiveness, experience, value_density, product_score }
confidence
verification_level
unknowns[]
risks[]
community_strength { score, rationale, evidence_ids[] }
exposure { band, stars, dependents, downloads, rationale, evidence_ids[] }
analyzed_at
```

Each dimension contains `score`, the exact `max_score`, `rationale`, and at least one `evidence_id`. Maxima are 25, 30, 30, and 15. `product_score` must equal the four scores exactly.

Use only these machine values for `project.project_type`:

```text
micro_tool | sdk_library | web_app | desktop_app | framework_platform | database_infra | template_scaffold | enterprise_system
```

Type-guide filenames are human-facing labels and are not valid enum values. For example, `micro-tool.md` maps to `micro_tool`.

`project.product_tags` contains 3-5 concise, evidence-backed product characteristics:

```text
{ slug, labels { zh, en }, evidence_ids[] }
```

- `slug` is a stable lowercase kebab-case identifier such as `local-first` or `cross-tool-search`.
- `labels.zh` and `labels.en` are short user-facing labels, not sentences.
- Every tag references at least one evidence entry that directly supports it.
- Prefer the problem solved, interaction model, deployment model, or differentiating capability: `本地优先 / Local-first`, `跨工具检索 / Cross-tool search`, `CLI/TUI`, `OpenAPI 转 CLI / OpenAPI to CLI`.
- Do not use internal classifications or verification states as product tags, including `micro_tool`, `active_evolution`, or `source_inspected`.
- Do not emit generic labels such as `开源项目 / Open-source project`, `工具 / Tool`, `高质量 / High quality`, or marketing claims unsupported by evidence.
- Do not repeat the same idea with synonyms. Tags must distinguish this project from other projects in the same `project_type`.

Use only these machine values for `project.lifecycle`:

```text
active_evolution | stable_maintenance | feature_complete | experimental | abandoned
```

Risk severity is one of `info`, `low`, `medium`, `high`, `critical`. Risk category is one of `license`, `security`, `supply_chain`, `maintenance`, `compatibility`, `privacy`, `operations`, `other`.

Every `risks[]` entry must have exactly this shape:

```text
{ severity, category, summary, evidence_ids[] }
```

Use `summary`; do not emit `title` or `description` fields.

`community_strength.score` is an independent 0-100 evidence summary of contributor depth, user support, and ecosystem resilience. It has zero weight in `product_score`; a large organization or many contributors cannot improve the product-value score.

Use JSON `null` for unavailable `requested_ref`, `stars`, `dependents`, or `downloads`.

## Human-facing locale

The task carries a BCP 47 locale. Write all human-facing evaluation prose in the requested language and regional convention:

- Analysis JSON: `project.summary`, every `project.target_users` item, `project.pain_statement`, all score `rationale` values, all `unknowns` items, every risk `summary`, `community_strength.rationale`, and `exposure.rationale`.
- Evidence JSON: every entry `summary`.
- Markdown: the complete report, including headings and all explanatory prose.

Use the primary language subtag for language and the region subtag for script, spelling, terminology, and formatting. For example, `zh-CN` uses Simplified Chinese, `zh-TW` uses Traditional Chinese, `en-US` uses US English, and `en-GB` uses British English.

Keep product/repository names, proper nouns, URLs, paths, commands, commit SHAs, API names, code identifiers, and machine enum values unchanged. Product tags stay bilingual under the current schema: `labels.zh` is Chinese and `labels.en` is English.

## Evidence JSON

Required fields:

```text
schema_version
analysis_id
repo_key
resolved_commit_sha
entries[]
```

Each evidence entry contains:

```text
id
kind = metadata | source | documentation | command | build | test | runtime | external
summary
outcome = pass | fail | partial | unknown
command? path? exit_code? excerpt?
```

Keep excerpts short and redact secret-shaped values. Every referenced evidence ID must exist exactly once.

## Report Markdown

Write the complete report in the requested locale and use this order:

1. Verdict and product score.
2. Product contract and pain.
3. Four score dimensions.
4. What was actually verified.
5. Unknowns and adoption risks.
6. Community strength, exposure context, and leaderboard interpretation.

Do not describe private reasoning. Explain conclusions through observable evidence.
