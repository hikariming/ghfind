# Feed 首次生产切换的 schema、候选和回滚边界

审计基准：当前 `dc64f28703364209bff6d701fd89dfdfa9b085cc`；历史部署程序 `aa8c683fefca182428a48c180af7e862f7469929`。两者的 `src/lib/feed.ts`、`src/lib/d1-client.ts`、源提交事务及当时 migration 内容相同。追加验证涵盖发布负责人实现的 `0012_feed_legacy_writer_fence.sql`、adapter batch、治理和 schema-readiness；本测试/文档不拥有这些实现，不创建 migration、不查询或写入远端。

结论：**可以先升级 schema、以 off 模式准备独立运行面，再短暂暂停 Feed 并切到 Go。前提是第一次 Go 用户、任务或治理写入之前，已验证 Go-only 暂停入口，并在 D1 激活实际拒绝旧 SQL 的 `0012` 栅栏。** 新增 schema 没有破坏旧表操作，但实测发现旧 Feed 在 235 个合成候选下已有 D1 参数超限故障；不能声称旧完整业务在该目录规模下可用。一旦 Go 开始写入，不能把旧 Next 当作兼容回滚程序。`writer_epoch` 和 writer contract 表不会自动拦截不了解它们的旧 SQL；`0012` 的显式数据库触发器承担这项责任，默认关闭，必须按发布步骤激活。

## 已核验的证据边界

主 agent 于本轮提供的远端只读文件：`/tmp/ghfind-go-production-20260909/feed-counts-before.json`、`core-schema-before.json`。Feed migration ledger 只有 `0001`、`0002`；261 个项目、235 个 `published=1`，用户、事件、曝光为 0。核心库已安装 `0001`、两个不同文件名的 `0002`、`0003`、`0004`；尚无源 outbox。上述文件由发布负责人读取，本测试未访问远端。

这些数量是时点读回，切流前仍须确认没有新写入。235 是旧发布标记数，**不是 Go 的可推荐数**。对未安装的 provenance/outbox 表，结论是“尚无该能力”，不能执行不存在表的 COUNT 后把错误写成零。

新增 `scripts/feed-production-compatibility.test.mjs` 使用真正的本地 workerd D1/R2：从历史提交的 baseline migrations 建库、加入显式合成的 261/235 行，再应用当前 `0003..0012` 和核心 `0005/0006`。历史 Next 模块从准确旧 SHA 读取，经过原应用 D1 adapter 执行；Go 存储语义通过实际 capability Worker 检验。本测试不冒充 Go HTTP/OAuth 完整 E2E或生产评测证据。产物固定 `productionAcceptance:false`、`legacyRollbackCompatible:false`，同时记录 checkout 是否干净及本次被测 migration/store/governance/readiness/test 的 SHA-256；临时整合中的成功结果不能冒充准确发布 SHA 的完整 E2E。

执行命令：

```sh
pnpm install --frozen-lockfile
pnpm --dir platform/feed install --frozen-lockfile
node --import tsx --test scripts/feed-production-compatibility.test.mjs
pnpm exec eslint scripts/feed-production-compatibility.test.mjs
```

每次运行使用新建本地资源，禁止外部网络，清理 D1/R2 持久目录后只保留合成证据。缺少依赖直接失败，无 skip。通过测试表示已证明下面的兼容条件和不兼容反例，不表示允许直接生产切流。

## Schema 升级对旧程序的影响

| Migration | 变化 | 首次 Go 写入之前 |
|---|---|---|
| Feed 0003 | 运行控制、提交证据、请求、会话、事件、profile floor | 不修改旧业务事实；不自动生成证据 |
| Feed 0004 | 离散执行器、投影 source version、用户标签提议 | 新表；旧 Next 不使用这些用户提议表 |
| Feed 0005 | 删除 checkpoint、归档索引、operator 记录 | 新表；当前生产没有这些历史删除任务 |
| Feed 0006 | replay delivery、DLQ terminal | 新表和索引 |
| Feed 0007 | reader/writer 兼容范围 | 新控制表，不能物理封住旧 SQL |
| Feed 0008 | discovery 部分索引 | 仅索引，保留事实 |
| Feed 0009 | 治理命令及 active taxonomy 唯一索引 | 必须预查 active taxonomy 恰好一个；不自动批准提议 |
| Feed 0010 | 重建新版用户提议表、增加 tag origin、删除重启 | 重建的是新表，不是旧 `feed_tag_proposals`；旧 column-list INSERT 不受新增列影响 |
| Feed 0011 | 用户提议删除修复、writer contract 2 | 当前无旧新版提议时无归属修复；首次运行后只允许兼容 writer 2 |
| Feed 0012 | 旧表 DML 触发器及 adapter 原子 context | 默认 enabled=0，保留旧行为；显式激活后，13 张旧表的 INSERT/UPDATE/DELETE 均要求同事务的 adapter context |
| Core 0005/0006 | receipt/outbox 与人工 replay audit | 新表和索引；源开关开启前无写入这些表的业务路径 |

不能只看 `feed_runtime_control.schema_version`：它在新增能力后仍为 7。readiness 还检查所需表、列和 reader 1 / writer 2 范围；0012 增加 fence/context 两张表的存在性检查，migration ledger 的文件版本仍需独立核验。

本地对照发现历史 Next `loadCandidates` 在查询 tags/states 时以候选数生成 `IN (?,...)`，235 个合成可发布项目使真实 workerd 报 `too many SQL variables`。此故障在只安装 0001/0002 时就出现，升级后依旧出现，不能归因于新增 migration。测试明确保留两次失败反例，随后仅为隔离 schema 因素把合成目录暂限为两个项目：旧偏好、Feed 页、save、事件去重及只涉及旧事实的删除均通过，并恢复原合成目录。此验证不适用于 Go 写入后的同用户事实，也不意味着新旧运行面可长期共写。

0010 的裸 SQL **不支持重复执行**。本地重放会在已有 view / 重建表关系处失败，D1 batch 回滚整个序列并保留原 schema。正式执行必须用 migration ledger 跳过已应用文件；不能重复发送全目录 SQL 或删除 ledger 使其“重试”。[D1 batch 的事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)也是本地失败恢复测试的依据。新的生产 source-control migration 仍由发布负责人独占编号和审核。

## 为什么旧 Next 不能成为 Go 写入后的回滚目标

以下反例均在 0012 的 `enabled=0` 阶段执行，以证明仅凭运行控制版本不足以保护新事实；不是关闭已投入使用的生产栅栏后做测试。

1. `ensureUser` 固定从 profile version 1 创建用户，未检查 `feed_profile_floors`。本地先通过真实 Go capability 删除版本 1，再运行历史 Next GET/preferences：旧程序重新插入版本 1，等于已删除 floor；只用 Go 重新进入则为版本 2。
2. 旧偏好、曝光、state 和事件写入不检查 writer epoch、writes_enabled 或 writer contract。本地关闭写入后，Go ensure 返回 409，旧 GET/preferences 仍成功写入。
3. 旧 `deleteFeedProfile` 只删除六张旧表，并立即返回 `completed`。测试在同一 D1/R2 中放入 Go 归档事实后调用历史实现：真实 R2 字节、归档 metadata 和 behavior signal 仍然存在，且没有新增 floor 或清理任务。
4. 旧 Feed 查询只检查 published / moderation / 用户状态，没有新 provenance 条件；固定 taxonomy 1 也不等于 Go 治理后的当前版本。
5. 已存在的 `requireLegacyCatalogWriter` 只封住 projection、reconcile、review。它没有替代对全部用户请求的路由控制，回退为 legacy 会重新开放上述路径。

因此 1%/10% 灰度必须保证未选中用户不回到同库旧写入面。暂停页、返回 503 或仅内部账户访问是可说明的首发阶段；不能以旧 Next fallback 掩盖缺少兼容程序。新 Web `FEED_BACKEND=go` 的暂停锚点必须继续拦截所有 Feed 路由，尤其 DELETE/profile 和具有写入副作用的 GET。

## 实际拒绝旧写入的验收

固定 `sleep 35` 或改成更长等待都不是旧 Worker 已排空的证明。Cloudflare 对仍连接的 HTTP 请求没有 wall-clock 硬上限；文档中的 30 秒 grace 指平台更新 runtime，并非本项目应用发布的 drain 协议。[Workers duration 限制](https://developers.cloudflare.com/workers/platform/limits/)

0012 默认 `enabled=0`；发布负责人确认新的 Go-only paused Web 已实际接收 100% 流量后，显式激活。全部 13 张历史 Feed 业务表安装 INSERT/UPDATE/DELETE 触发器：激活后若同一事务不存在 adapter context，执行 `RAISE(ABORT,'legacy_feed_writer_fenced')`。新 adapter 的 `FeedStore.batch` 把唯一 context 的插入、全部原语句和 context 删除放在**同一个 D1 batch**；向调用方返回时剔除新增首尾结果，以保持治理等调用方的结果索引。

真实 workerd 测试包括：

- inactive 时保留前述历史程序兼容与失败反例；active 后逐表针对实际存在行发送 39 种旧 DML，全部拒绝且事实不变。另经历史 Next 模块调用新增/既有用户 GET 与删除，确认不能绕过触发器。
- active 时通过实际 adapter HTTP 完成用户 ensure、偏好、治理 create/map/deprecate、删除和重新进入；治理标签、alias、命令 receipt 和递增的 taxonomy/profile 版本均读回。
- 在同一个允许的 adapter batch 中先修改用户，再触发项目 CHECK 失败：先前修改与 context 一起回滚；下个命令仍成功。原语句结果数量和下标保持原义。
- 四轮真实 D1 并发运行较长的 adapter batch 和旧写请求，48 次旧写全部被拒绝，16 次并发读均看不到未提交 context；数据库最终只保留允许的更新，context 始终为空。

这是一道针对旧程序的 SQL 兼容栅栏，不是抵御持有原始 D1 管理权限者的访问控制。具备直接 SQL 权限者仍能修改控制表，必须由同一 Actions 发布负责人串行操作；应用不暴露任意 SQL RPC。不能将 context 长期写入数据库来“修复”被拒请求，也不能在 Go 已写入后关闭 fence 重新开放 legacy。schema、快照和恢复工具须保留控制语义，context 在正常状态及可恢复快照中必须为空。

栅栏保护 Feed DML，不会补造旧进程先前已经完成的核心评测 outbox。旧源流程在切换瞬间完成而缺少真实 submission receipt 的记录，仍须按来源核验和有界修复流程处理，不得因它发生在暂停窗口就推断提交资格。

## 历史项目准入与必要的回填

Go D1 adapter 只接收 `published=1`，并且当前 `repo_key + analysis_id` 在 `feed_submission_provenance` 或 `feed_project_source_versions` 中具有未撤回证据的项目；moderation 和用户负反馈继续排除候选。测试证明：历史 261/235 行完整升级，但证据表为空时，候选为零；错误 analysis、revoked 证据和撤稿不能通过。

核心 migration 不从 completed run 推断用户提交。当前 outbox selector 要求同一个 run 的 receipt、completed 状态、最新 assessment 和已有 artifact hash。测试中完成记录本身不产生事件；显式合成的提交意图调用真实固定 statements 后产生一份 receipt/outbox，重复操作不增加第二份。

首批真实候选有两条合法路径：

- 用户对选定公开项目真实 POST 提交；若命中已完成评测，`recordAppSubmission` 可复用该 run，记录当前提交意图和 outbox，无须再执行付费评测。随后真实 relay、executor 读取核心事实、核验 hash 并生成投影。是否命中缓存由真实接口和 run 身份读回证明。
- 仅对有可复核历史提交记录的逐项目 allowlist 作 `verified_backfill`。记录 analysis ID、repo、真实提交时点、证据引用及审核人，使用同库 receipt/outbox 事务，再走相同执行器。当前没有通用的已验收历史导入接口，若采用此路线需另行实现并验收有界 operator 工具。

不可把全量 `project_assessments` 或 235 个 published 项目批量改写成 `app_submission` / `verified_historical`，也不可直接向 Feed provenance 表写自造记录以跳过核心源核验。来源不明的项目保留公开页，继续从新 Feed 隔离。历史标签提议保持原状态，首批标签治理走明确的 operator 操作。

## 最小推进顺序和暂停锚点

1. 发布负责人读回生产 schema ledger、active taxonomy、旧 Feed 数量、源任务状态及发布版本；保留恢复锚点。通过准确 SHA 的本地完整 E2E 和 CI 后，Actions 串行应用 core 0005/0006、Feed 0003..0012，保留 fence enabled=0。此时旧 Web 的源开关仍为 false，独立 runtime 尚未接受任何业务写入。
2. 部署 off runtime/adapter，仅验证真实版本、bindings、readiness。证明 off 不创建用户、任务、投影或治理记录；health 不能触发建表或业务补种。旧 Next 暂时可以继续旧流程，但这是最终退出之前的短暂准备窗口。
3. 一次部署新 Web：`FEED_BACKEND=go`、`FEED_ROLLOUT_MODE=paused`、`FEED_SOURCE_OUTBOX_ENABLED=true`。所有 Feed 请求无 fallback；旧 catalog/projection/reconcile/review 写入被拒绝。新提交在核心数据库记录 receipt/outbox，因此暂停期间不会丢失已接受的新提交意图。
4. 读回新 Web 100%、旧版本 0%，确认独立入口和计划任务也不再使用旧 writer；显式将 `feed_adapter_write_fence.enabled` 设为 1，并读回 enabled=1、context 数量=0。该事务提交后，存活的旧请求不能再提交旧 Feed DML；不以固定等待代替栅栏。旧读取也可能写用户/曝光，不能只控制 POST。重读用户/事件/曝光数量，不沿用先前 0 的快照。
5. 激活 runtime baseline，取得实例实际 mode/SHA/readiness，并读取实际队列消费者、DLQ 和 cron 设置；随后验证首批真实候选和隔离事实。任务积压是持久状态，不应靠旧 Next projection 补齐。
6. 按批准的有界内部/放流步骤打开 Web，实际核验鉴权、偏好、事件、删除和无内部分数。首发暂停模式是安全止损锚点，不是已验证的“恢复服务≤5分钟”。首个兼容 Go 程序回滚锚点尚需后续发布演练建立。

如果步骤 2 无法证明 off 真正不写入，应把步骤 3 的暂停提前。任何 Go 写入开始后都不可切回旧 Next、删除生产表或逆向运行破坏性 migration。

## 发布负责人执行的只读核验

先查询表存在及 migration ledger；下列后续查询仅在相关表已存在时运行。查询不得改写项目或泄露用户明细。

```sql
SELECT name FROM d1_migrations ORDER BY name;
SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'feed_%' ORDER BY name;
SELECT version,status FROM feed_taxonomy_versions ORDER BY version;
SELECT COUNT(*) AS active_count FROM feed_taxonomy_versions WHERE status='active';
SELECT COUNT(*) AS projects,SUM(published=1) AS published FROM feed_projects;
SELECT COUNT(*) AS users FROM feed_users;
SELECT COUNT(*) AS events FROM feed_events;
SELECT COUNT(*) AS served FROM feed_served_items;
```

安装新版 Feed schema 后：

```sql
SELECT * FROM feed_runtime_control;
SELECT * FROM feed_schema_compatibility;
SELECT enabled FROM feed_adapter_write_fence WHERE id=1;
SELECT COUNT(*) AS leaked_contexts FROM feed_adapter_write_context;
SELECT * FROM feed_user_proposal_quarantine_summary;
SELECT COUNT(*) AS total,SUM(p.published=1) AS published,
  SUM(p.published=1 AND (
    EXISTS(SELECT 1 FROM feed_submission_provenance v WHERE v.repo_key=p.repo_key AND v.analysis_id=p.analysis_id AND v.revoked_at IS NULL)
    OR EXISTS(SELECT 1 FROM feed_project_source_versions v WHERE v.repo_key=p.repo_key AND v.analysis_id=p.analysis_id AND v.revoked_at IS NULL))
    AND NOT EXISTS(SELECT 1 FROM feed_project_moderation m WHERE m.repo_key=p.repo_key AND m.removed=1)) AS eligible_before_user_filters
FROM feed_projects p;
SELECT status,COUNT(*) AS jobs FROM feed_execution_jobs GROUP BY status;
SELECT status,COUNT(*) AS deletions FROM feed_profile_deletions GROUP BY status;
SELECT COUNT(*) AS reused_deleted_generations FROM feed_users u JOIN feed_profile_floors f USING(github_id) WHERE u.profile_version<=f.profile_floor;
PRAGMA foreign_key_check;
```

核心新表安装后：

```sql
SELECT source_kind,COUNT(*) AS receipts FROM feed_submission_receipts GROUP BY source_kind;
SELECT status,COUNT(*) AS events,MIN(sequence) AS first_sequence,MAX(sequence) AS last_sequence FROM feed_source_outbox GROUP BY status;
SELECT COUNT(*) AS latest_completed_without_receipt FROM project_assessments a
JOIN project_analysis_runs r ON r.id=a.latest_analysis_id AND r.status='completed'
WHERE NOT EXISTS(SELECT 1 FROM feed_submission_receipts s WHERE s.analysis_id=r.id);
SELECT COUNT(*) AS inconsistent_source_identity FROM feed_source_outbox o
LEFT JOIN feed_submission_receipts s ON s.id=o.receipt_id
LEFT JOIN project_analysis_runs r ON r.id=o.analysis_id
WHERE s.id IS NULL OR r.id IS NULL OR s.analysis_id<>o.analysis_id OR r.repo_key<>o.aggregate_key OR r.analysis_sha256<>o.source_hash;
```

SQL 中的 hash 字段一致只证明列的关系；真实 source capability 还需重新计算 `analysis_json` 字节 hash，验证解析后的 artifact 与最新 assessment、run、receipt 绑定。历史缺 receipt 的数量不授权自动回填。

## 交接

本提交只交付本地兼容测试和审计，须与发布负责人拥有的 0012/adapter 变更一起集成。公共 HTTP/writer contract 保持 1/2，数据库物理 schema 新增 0012，runtime control 保持 7。下一阶段由主 agent 独占 migration 应用、暂停锚点部署、off 行为验证、实际数据库栅栏激活、候选合法补齐和生产放流。发布 PR 须附准确 SHA 的完整 E2E/CI、CF 版本读回、真实候选来源和操作 manifest。本地反例通过不能替代这些门槛。
