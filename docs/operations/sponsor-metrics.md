# 广告位曝光与点击统计

所有赞助与招聘展示位的曝光、点击都按「北京时间自然日 × 广告 × 展示位」累加在 D1 `ad_daily_stats` 表（`migrations/0034_ad_daily_stats.sql`）。

## 数据怎么来

- 前端带 `data-track-slot` 属性的链接（`slotAttrs()`，`src/lib/slot-metrics.ts`）由 `src/components/SlotMetrics.tsx` 统一采集，用 `sendBeacon` 发到 `POST /api/sponsors/pulse`。
- **曝光**：元素至少 50% 可见并持续 1 秒；同一页面路径内每个广告位只计一次。
- **点击**：每次左键或中键点击都计一次。
- 不计入：headless 自动化（`navigator.webdriver`）、爬虫 UA、跨站请求、不存在的广告 id。
- 拦截了 JS 或这个请求的访客，曝光和点击都不会计入，所以 CTR 的分子分母口径一致。
- 这是运营参考数据，不是计费级数据：有人刻意写脚本仍然可以刷量。
- 上线前没有任何历史点击数据，统计从迁移部署当天开始。

## 字段

| 字段 | 含义 |
| --- | --- |
| `day` | 北京时间日期 `YYYY-MM-DD`；月份用 `substr(day, 1, 7)` |
| `ad_kind` | `sponsor`（sponsorships）/ `job`（jobs）/ `company`（job_companies 招聘官网链接）/ `static`（写死的鸣谢，如 MiniCPM） |
| `ad_id` | 对应表的 id |
| `placement` | `top_strip` 头部条、`home_row` 首页中部赞助位、`model_credit` 模型鸣谢、`footer` 页脚、`pill`、`sponsor_page` 赞助页、`home_hiring` 首页招聘、`jobs_board` 岗位页、`job_detail` 岗位详情 |
| `advertiser` | 稳定的赞助商 key：赞助位取 `sponsorships.advertiser_id`，招聘取 `company_id`。例如 ModaLeap 的赞助位和岗位都归到 `modaleap` |

新增赞助行时请填写 `advertiser_id`（为空时回退为 sponsorship id）；同一家公司要和 `job_companies.id` 保持一致。

## 常用查询

在 `--env production --remote` 下执行，例如：

```sh
wrangler d1 execute ghfind --env production --remote --command "<SQL>"
```

按天（最近 30 天，全部广告汇总）：

```sql
SELECT day, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
       ROUND(100.0 * SUM(clicks) / NULLIF(SUM(impressions), 0), 2) AS ctr_pct
FROM ad_daily_stats
WHERE day >= date('now', '+8 hours', '-30 days')
GROUP BY day ORDER BY day DESC;
```

按月 × 赞助商：

```sql
SELECT substr(day, 1, 7) AS month, advertiser,
       SUM(impressions) AS impressions, SUM(clicks) AS clicks,
       ROUND(100.0 * SUM(clicks) / NULLIF(SUM(impressions), 0), 2) AS ctr_pct
FROM ad_daily_stats
GROUP BY month, advertiser ORDER BY month DESC, clicks DESC;
```

某赞助商按展示位拆分（例如本月 modaleap）：

```sql
SELECT placement, ad_kind, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
       ROUND(100.0 * SUM(clicks) / NULLIF(SUM(impressions), 0), 2) AS ctr_pct
FROM ad_daily_stats
WHERE advertiser = 'modaleap' AND substr(day, 1, 7) = strftime('%Y-%m', 'now', '+8 hours')
GROUP BY placement, ad_kind ORDER BY clicks DESC;
```

单个岗位或单个赞助位的明细（带当前标题）：

```sql
SELECT s.day, s.placement, s.ad_id, COALESCE(t.title, sp.sponsor_name) AS label,
       s.impressions, s.clicks
FROM ad_daily_stats s
LEFT JOIN job_translations t ON s.ad_kind = 'job' AND t.job_id = s.ad_id AND t.locale = 'zh'
LEFT JOIN sponsorships sp ON s.ad_kind = 'sponsor' AND sp.id = s.ad_id
WHERE s.day >= date('now', '+8 hours', '-7 days')
ORDER BY s.day DESC, s.clicks DESC;
```
