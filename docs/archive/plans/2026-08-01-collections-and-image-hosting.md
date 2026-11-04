# 推荐栏目（Collections）+ 图片托管与去 Vercel 化路线

> 背景：站内已有 /projects 算法榜（贡献者质量排序）、/developers facet 目录、/leaderboard、blog/研报。缺的是**编辑精选**入口——面向搜索词的合集落地页，同时为后续发文准备图片托管，并逐步降低 Vercel 依赖。
> 勘探结论（2026-08-01）：无现成 curation 功能；博客 `![]()` 经 `Figure.tsx` 渲染为纯 `<img>`（不走 next/image，外链图零代码改动）；ghfind.com NS 在 Vercel（ns1/ns2.vercel-dns.com）；无对象存储配置。

## 一、推荐栏目：Collections（项目 + 开发者合集）

**定位**：与 07-09 方案的 /projects 榜互补——榜回答"全量里谁最强"，合集回答"这个主题下我们推荐谁、为什么"。合集页是经典 SEO landing page（"值得关注的 X 项目 2026"类搜索词）+ 对外传播的载体。

**卖点**：编辑选题 + 引擎数据。编辑只写推荐语，star/tier/分数/贡献者质量从库里实时拉——数据永远新鲜，与人肉维护的 awesome 榜单差异化。

### 1. 数据：文件驱动，不进 DB

`content/collections/<slug>.json`（编辑走 git review，无后台成本）：

```jsonc
{
  "slug": "ai-agent-projects",
  "type": "mixed",                     // projects | developers | mixed
  "title": { "zh": "…", "en": "…" },   // 其余 locale 回落 en，沿用 i18n 策略
  "intro": { "zh": "…", "en": "…" },
  "items": [
    { "kind": "repo", "id": "openclaw/openclaw", "blurb": { "zh": "…", "en": "…" } },
    { "kind": "developer", "id": "someuser", "blurb": { "zh": "…", "en": "…" } }
  ],
  "publishedAt": "2026-08-01",
  "tags": ["ai-agent"]
}
```

### 2. 路由与渲染

- `/[locale]/collections`（索引）+ `/[locale]/collections/[slug]`（详情）。
- SSG：`generateStaticParams`（有限集合）+ `revalidate: 86400`。**不做 tag×locale 组合页**——吸取 facet 全表扫描 / 爬虫账单教训，URL 面保持有限可枚举。
- 条目卡片数据：repo 走 `getRepoOverview`（已有），developer 走 `scores` 行；缺数据时优雅降级为纯推荐语卡片。
- 主链接全部进站内 `/developers/repo/...` / `/u/...`，GitHub 外链降为角标（沿用 Phase B 的 RepoCardLink 模式）。

### 3. SEO / 互链 / 埋点

- sitemap 照 blogRoutes 模式收录；`localeAlternates` hreflang；JsonLd `ItemList`。
- 标题即搜索词："Best AI agent projects 2026 — ranked by who builds them"。
- 互链：首页/blog/研报导流入口；repo/开发者页"入选合集"反链徽章（可后置）。
- `track.ts` 加 `collection_view` / `collection_item_click`。
- 与研报联动：每篇 Who-builds-X 天然配一个合集，互相反链。

### 4. 首批内容（库里已有数据可支撑）

1. AI Agent 开源项目 ×"谁在做"（OpenClaw/Dify 数据现成）
2. 值得 follow 的开源开发者（用 followers/total_stars 列筛候选，编辑精选）
3. 之后按月一期"编辑推荐"，形成节奏。

**工期**：schema + 两个路由 + sitemap + 埋点 ≈ 1~1.5 天；OG 图后置。

## 二、图片托管：Cloudflare R2 + img.ghfind.com

**结论**：用 R2，不用 Vercel Blob、不放 public/。核心理由：R2 出流量 $0（Blob/public 的带宽全计 Vercel 账单，且爬虫拉图会放大——账单事故教训）；存储免费额度 10GB 够用很久；博客渲染已是纯 `<img>`，外链 URL 零代码改动，也不会误入 Vercel Image Optimization 计费。

### 前置：DNS 迁到 Cloudflare（R2 自定义域的硬要求）

1. 导出现有记录：`vercel dns ls ghfind.com`，逐条记下。
2. Cloudflare 免费版添加站点，复刻全部记录；**主站 A/CNAME 一律灰云（DNS only）**——流量仍直达 Vercel，WAF/BotID/证书行为零变化（外部 DNS 是 Vercel 官方支持模式，按项目域名设置页提示的 A/CNAME 值配）。
3. 注册商处改 NS → Cloudflare，过渡期观察。
4. 建 R2 bucket `ghfind-assets`，绑自定义域 `img.ghfind.com`（此条自动橙云走 Cloudflare CDN）；r2.dev 公开访问保持关闭。

### 上传流程

- 写 `scripts/upload-image.mts`：输入本地图 + slug → sharp 压成 webp（宽 ≤1600）→ 文件名 = 内容哈希 → S3 API 上传（R2 key 走 env）→ `Cache-Control: public,max-age=31536000,immutable` → 输出可直接粘贴的 markdown。
- 临时手动：`wrangler r2 object put ghfind-assets/blog/<slug>/<file> --file=… --remote`。
- URL 规范：`https://img.ghfind.com/blog/<slug>/<hash>.webp`；markdown `![说明](URL "图注")`，Figure 已支持图注。

## 三、"少用 Vercel"路线（渐进，不冒进）

1. **本次**：图片/静态资产出走 R2（零风险）；DNS 落 Cloudflare 后，后续所有动作都有抓手。
2. **观察**：07 月已治理的主成本是"给机器人渲染页面"（WAF challenge + facet ISR 6h）。图片外置后 Vercel 剩余成本在 compute + ISR 写，继续按 07-18 cost-audit 清单拆雷。
3. **中期可选**：纯静态内容（blog/研报）迁 Cloudflare Workers 静态资产（免费额度大），按子域或路由拆分。
4. **不建议现在整站迁移**（OpenNext→Workers 可行但风险高——7 月两次上线事故的教训）；等流量/收入结构稳定再评估。

## 实施顺序

```
DNS 迁 Cloudflare（用户操作，半小时）──→ R2 bucket + img 域 ──→ upload-image 脚本
Collections schema + 路由 + sitemap + 埋点（可并行，不依赖上面）──→ 首批 2 个合集内容
```
