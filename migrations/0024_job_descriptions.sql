-- Job detail pages: full JD markdown per locale (falls back to en, then zh, like
-- the other copy fields). Cards with a description link to /jobs/<id> instead of
-- straight to apply_url. Also moves the Megatron logo to R2 (ghfind-assets) so it
-- does not depend on a public/ deploy.
ALTER TABLE job_translations ADD COLUMN description TEXT;

UPDATE job_companies
SET logo_url = 'https://assets.usedify.app/jobs/megatron.png',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'megatron';

UPDATE job_translations SET description = '## 岗位信息

- **工作性质**：全职
- **工作地点**：上海，面向全球市场
- **预期薪资**：20,000–35,000 元/月（税前）
- **薪资说明**：能力突出可谈 30K–38K；
- **福利**：五险一金、绩效奖金

## 岗位定位

加入上海初创团队，负责面向全球开发者的 AI API / Developer SaaS 产品。岗位处于产品、增长和研发协同的交叉位置，需要推动产品从需求定义、研发交付到全球用户自助购买和持续使用的完整闭环。

## 岗位职责

### 1. 负责全球产品闭环

- 负责需求收集、User Story、优先级、Roadmap 与发版节奏。
- 规划从注册、API Key 创建、Docs 使用、首次调用到付费和持续使用的完整路径。
- 深度理解海外开发者场景，包括统一 Endpoint、多模型切换、Latency、Pricing 透明、Team Key 和 Usage。
- 基于用户反馈、数据和研发资源持续迭代产品。

### 2. 主导商业化设计

- 负责 Pricing Page、套餐、Credits、Subscription、Pay-as-you-go、试用额度和 Referral 等产品设计。
- 关注 Signup、First Paid、MRR、Churn、ARPU/LTV、Usage、毛利和 Provider 成本。
- 设计余额、用量、扣费、失败补偿、退款和升级路径等核心规则。
- 与研发协作推进支付、订阅、账户、权限和计费体验。

### 3. 增长协同

- 与出海产品增长共同定义增长漏斗和实验优先级。
- 协同优化 Landing、Pricing、Onboarding、Docs 和 Console。
- 围绕 `Signup → API Key → First Successful Call → First Paid → Retained Usage` 识别阻塞点。
- 参与激活、付费、留存和商业化实验，但不承担日常投流执行主责。

### 4. 研发协同

- 能理解 API Gateway、Billing、Provider 成本、限流、可用性和技术边界。
- 将产品目标拆解为 User Story、接口约束、验收标准和可交付版本。
- 与前端、后端共同推进 API Contract、Docs、Usage、Logs、Team / Org 和预算上限等能力。
- 在初创资源有限的情况下完成 MVP 取舍、排期和上线验收。

### 5. 市场与竞品研究

- 扫描国际 AI Gateway、AI API Marketplace、Developer Tools 和相关 SaaS 产品。
- 研究海外开发者采购、集成、定价和使用路径。
- 输出可执行的市场判断、竞品分析和产品机会。

### 6. English-first 产品表达

- 推动产品文案、Docs、Pricing、Support 话术和错误提示的英文表达。
- 独立完成英文竞品研究、产品文档和基础用户沟通。
- 能通过邮件、Issue、Discord 等方式处理常见产品问题。

## 任职要求

- 3 年及以上产品经理经验，SaaS、Developer Tools、出海产品或平台型产品经验优先。
- 有 0 到 1 或早期 PMF 验证经历，能从数据闭环驱动产品迭代。
- 理解增长漏斗和 KPI 拆解，能与增长或运营协作推动实验落地。
- 能与研发讨论 API、计费、限流、可用性、模型成本和交付边界。
- 熟悉订阅制 SaaS、开发者平台、支付订阅或按量计费产品心智。
- 英文读写熟练，能够完成英文产品文案、竞品研究、PRD 和简单用户邮件。
- 对 AI、LLM、模型 API 和全球开发者生态有兴趣。
- 适应初创团队节奏，主动推进、结果导向，不依赖重流程。

## 加分项

- 有纯出海或跨境 SaaS 从 0 到 1 经验。
- 做过 AI API、Developer Tools、云服务、B2B SaaS 或订阅产品。
- 有 Product Hunt、SEO、内容获客或 PLG 实操经验。
- 有 Stripe、Credits、Pay-as-you-go、Subscription、Referral 或 Usage-based Billing 经验。
- 了解 GDPR、退款政策、税务展示、数据隐私等出海合规基础。
- 熟悉 Figma 或其他产品原型工具，能写清晰的英文 PRD。

## 早期阶段的工作特点

- 产品经理需要直接参与竞品研究、用户访谈、PRD、英文文案、Docs、数据口径、验收和用户反馈整理。
- 团队资源有限，需要围绕关键用户路径持续做 MVP 取舍。
- 产品结果会以全球用户的激活、首次调用、首次付费、持续使用和毛利表现衡量。
- 不要求候选人替代核心后端或纯 Sales，但需要能成为产品、研发和增长之间的有效桥梁。

## 我们提供

- 五险一金、绩效奖金。
- 直接面对全球用户和真实付费转化场景。
- 与产品、前端、后端直接协作，决策快、反馈周期短。
- 有机会从 0 到 1 建立出海 AI Developer SaaS 产品。'
WHERE job_id = 'megatron-product-manager' AND locale = 'zh';

UPDATE job_translations SET description = '## Role at a glance

- **Type**: Full-time
- **Location**: Shanghai, serving global markets
- **Salary**: ¥20,000–35,000 per month (pre-tax)
- **Salary note**: up to ¥30K–38K for outstanding candidates
- **Benefits**: Chinese social insurance and housing fund, performance bonus

## About the role

Join an early-stage Shanghai team building an AI API / developer SaaS product for developers worldwide. The role sits where product, growth and engineering meet: you will drive the full loop from defining requirements and shipping with engineering to global users buying on their own and staying active.

## What you will do

### 1. Own the global product loop

- Own requirement intake, user stories, priorities, the roadmap and release cadence.
- Design the full path from sign-up, API key creation and docs to the first call, payment and ongoing usage.
- Understand international developer needs in depth: a unified endpoint, switching between models, latency, transparent pricing, team keys and usage.
- Keep iterating based on user feedback, data and engineering capacity.

### 2. Lead monetization design

- Own the pricing page, plans, credits, subscriptions, pay-as-you-go, trial credits and referrals.
- Track sign-ups, first payment, MRR, churn, ARPU/LTV, usage, gross margin and provider costs.
- Define the core rules for balances, usage, charging, failure compensation, refunds and upgrade paths.
- Work with engineering on payments, subscriptions, accounts, permissions and the billing experience.

### 3. Partner with growth

- Define the growth funnel and experiment priorities together with the growth lead.
- Improve the landing page, pricing, onboarding, docs and console together.
- Find the blockers along `Signup → API Key → First Successful Call → First Paid → Retained Usage`.
- Take part in activation, conversion, retention and monetization experiments (day-to-day paid acquisition is not this role''s main job).

### 4. Partner with engineering

- Understand API gateways, billing, provider costs, rate limiting, availability and technical limits.
- Break product goals into user stories, interface constraints, acceptance criteria and shippable versions.
- Work with frontend and backend engineers on the API contract, docs, usage, logs, team/org features and spend limits.
- Make MVP trade-offs, plan schedules and sign off releases with a startup''s limited resources.

### 5. Market and competitor research

- Track international AI gateways, AI API marketplaces, developer tools and related SaaS products.
- Study how developers abroad evaluate, integrate, pay for and use these products.
- Turn research into actionable market calls, competitor analyses and product opportunities.

### 6. English-first product communication

- Drive English copy for the product, docs, pricing, support replies and error messages.
- Do English competitor research, product docs and basic user communication on your own.
- Handle common product questions over email, GitHub issues, Discord and similar channels.

## What we are looking for

- 3+ years as a product manager; SaaS, developer tools, global or platform products preferred.
- Experience going from 0 to 1 or validating early product-market fit, using data to drive iteration.
- Understands growth funnels and KPI breakdowns, and can run experiments with growth or operations.
- Can discuss APIs, billing, rate limiting, availability, model costs and delivery scope with engineers.
- Familiar with subscription SaaS, developer platforms, payments or usage-based billing.
- Fluent English reading and writing: product copy, competitor research, PRDs and simple user emails.
- Interested in AI, LLMs, model APIs and the global developer ecosystem.
- Comfortable with a startup pace: proactive, results-driven, no heavy process.

## Nice to have

- 0-to-1 experience on a product built for overseas or cross-border SaaS markets.
- Worked on AI APIs, developer tools, cloud services, B2B SaaS or subscription products.
- Hands-on Product Hunt, SEO, content-led acquisition or PLG experience.
- Experience with Stripe, credits, pay-as-you-go, subscriptions, referrals or usage-based billing.
- Basic knowledge of overseas compliance: GDPR, refund policies, tax display, data privacy.
- Comfortable with Figma or other prototyping tools; writes clear English PRDs.

## What the early stage looks like

- You will be hands-on with competitor research, user interviews, PRDs, English copy, docs, metric definitions, acceptance testing and user feedback.
- Resources are limited, so you will keep making MVP trade-offs around the key user journeys.
- Success is measured by global users'' activation, first call, first payment, ongoing usage and gross margin.
- You don''t need to replace a core backend engineer or a pure salesperson, but you should be an effective bridge between product, engineering and growth.

## What we offer

- Social insurance and housing fund, performance bonus.
- Direct contact with global users and real paid conversion.
- Close work with product, frontend and backend: fast decisions, short feedback loops.
- The chance to build a global AI developer SaaS product from 0 to 1.'
WHERE job_id = 'megatron-product-manager' AND locale = 'en';
