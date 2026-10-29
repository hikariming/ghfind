# v19 / v13 / v7：锐评缓存 bump（无容量改动）

仅升级 roast `v12 → v13`。score 保持 `v19`，collection 保持 `v7`。
**不**设 `ROAST_GENERATOR` / `ROAST_V13_SCOPE`（prod plain var，发版后由 ghfind-review 开）。

## 何时开这个 PR

`versions:check` 对 PR 使用 `--base-ref origin/<base>`。`dev → main` 会拿 tip 相对
`origin/main` 的整段 delta；若 tip 同时含 score 与 roast 前进，会触发
`formal release changes score, roast; multi-component bumps are forbidden`。

因此：

1. 先把 score v19（#599）合入 `dev`，再单独 `dev → main`（或等价单组件发布）；
2. **本 PR 在 score v19 已上 `main` 之后**再 rebase 到当时的 `main`/`dev` 并合入。

容量默认值已在独立 PR（`docs/releases/release-capacity-defaults.md` / #600）里抬高。

## 行为

- TS `ROAST_CACHE_VERSION` + Go `roastArtifactVersion` + manifest → `v13`
- 打开仍挂 v12 报告的档案 → `report-pending` / `roast_version_upgrade` → auto re-roast
- 生成器用当时的 `ROAST_GENERATOR`（未设则仍为 v12 单呼，但写入 v13 缓存键）
