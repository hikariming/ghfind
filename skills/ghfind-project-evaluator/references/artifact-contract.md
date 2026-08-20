# Artifact contract

Use UTF-8. Keep JSON machine-readable and Markdown human-readable.

## Analysis JSON

Required top-level fields:

```text
schema_version = ghfind.project-analysis.v3
analysis_id
repository { repo_key, canonical_url, requested_ref, resolved_commit_sha }
rubric_version
agent_version = project-evaluator-v3
skill_version = ghfind-project-evaluator-v4
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

`project.product_tags` contains 3-5 concise, evidence-backed product characteristics. Each tag must declare exactly one governed namespace: `domain`, `use_case`, `audience`, `artifact`, `stack`, or `stage`.

```text
{ namespace, slug, labels { zh, en }, evidence_ids[] }
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

`unknowns` is a curated list, not a dump of everything unexecuted. At most 4 entries. Each entry must be a decision-relevant unknown: a fact that, if known, could change a score, the confidence, or an adoption decision — and it must name what it affects (e.g. "无法确认生产采用规模，影响 exposure 与 community_strength 的可信度"). Facts about verification scope ("本次没有构建/没有运行 X") belong to the verification-level section, never to `unknowns`. Template phrasings such as 「未验证 X」「无法确认 Y」without an attached consequence fail this contract.

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

The report is the **reader view of the Analysis JSON**, not an independent essay. Scores come only from the JSON. The report may expand each `rationale` into narrative, but it must never change a score, reverse a judgment, or invent an evidence claim. Where the report and the JSON disagree, the report is wrong.

### Required structure

Use these sections in this order. The six dimensions below are the spine of the report; the Chinese titles shown are required for `zh-CN`, and other locales use natural equivalents in the same order with the same score annotations.

```text
# 产品潜力分析：<project name>

## 产品价值（X/100）
`product_score/100` · `confidence/100` · `verification_level`。
先一句总判断：这个项目值不值得关注、给谁看、为什么（不超过 3 句，不得复述后文）。

## 需求痛点（X/25）
先一句明确判断（真实且高频 / 真实但小众 / 存疑）加一句话原因，再给证据。
写清痛点发生在谁身上，以及目标用户在没有本项目时的具体工作流和现有替代方案为何不够。

## 解决效果（X/30）
按「核心承诺 → 已验证的实现证据 → 未验证的部分与缺口」顺序写。
必须明确回答：方案是否闭环解决了上一节定义的痛点。

## 上手与核心体验（X/30）
按「发现 → 安装 → 配置 → 首次成功 → 出错反馈」五步各给一句判断。
验证过核心流程的，写清实际观察到的行为；没验证的，说明卡在哪一步。

## 范围与价值密度（X/15）
判断功能边界是否克制、复杂度是否物有所值；指出可以砍掉的部分（如有）。

## 风险
逐条列出 risks 与 unknowns（没有就写「无」），每条一句判断加一句依据。

## 验证方式与可信度
本次实际执行了哪个验证级别、做了什么、没做什么，以及置信度为什么是这个数。

## 曝光与社区（不计入 product_score）
曝光档位与社区强度的客观上下文，以及因此进入哪个榜单或不进榜的原因。
```

### Style rules (hard requirements)

- Each dimension section opens with exactly one verdict sentence (好/一般/差 + one-sentence reason), then evidence paragraphs. A section that only lists observations without judging them fails this contract.
- Every claim must be checkable: point to a concrete file, observed command behavior, documentation content, or data point. Anything unverifiable goes to `unknowns` instead of being guessed.
- Each dimension section has at least two paragraphs (verdict + evidence) and no paragraph longer than five sentences.
- Filler phrases are banned, including 「值得注意的是」「综上所述」「不难发现」「总的来说」「在某种程度上」 and their equivalents in any locale.
- First-person narration is banned. The report is a product analysis for readers, not the agent's work log: never use 「我」 or "I" as a subject. State verification scope impersonally, e.g. 「本次验证未覆盖构建与执行（source_only）」 rather than 「我没有构建」.
- The 「不是 X，而是 Y」 contrast pattern may appear at most once in the whole report. Never stack more than two method/path/class names in a single sentence; implementation detail belongs to the evidence JSON, the report keeps only the references a judgment actually needs.
- Dimension section titles carry the exact JSON score (e.g. `Effectiveness 24/30`); the prose must match the JSON rationales and may deepen but never contradict them.
- Every factual judgment in the report must trace to at least one evidence entry. `evidence_ids` stay in the JSON; the report describes evidence in natural language.
- A report that fails the structural checks in `scripts/validate_artifacts.py` must be rewritten and re-validated before finishing.
