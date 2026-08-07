The first two founder's picks were about people: [Yuxuan Zhang](/collections/yuxuan-zhang) for the code half of open source, [Max Liu](/collections/max-liu) for the growth half. Starting with this issue we cover projects too, using the same method — ignore the star ranking, pull the contributor list, run every account through the scoring engine, and only then decide whether the project is worth recommending.

The first project is LobeHub (`lobehub/lobehub`): 81.2k stars, 15.8k forks, started May 2023, TypeScript. It now introduces itself as "your Chief Agent Operator", but most people met it under its old name, LobeChat — the open-source ChatGPT client you could deploy to Vercel in one click.

## First the people: who actually writes the 81k-star repo

On 4 August 2026 we pulled the repo's top 100 contributors by commit count. Beyond the three accounts GitHub labels as bots (renovate, dependabot, gru-agent), three more are machines: semantic-release-bot, lobehubbot and actions-user. Together those three pushed 4,220 commits — more than any human in the repo. That is a heavily automated release pipeline, which is its own kind of engineering-maturity signal. Drop all six and 94 humans remain.

Twenty-eight of them already carry a score in the ghfind database:

| Metric | LobeHub top-100 contributors | Site-wide baseline (18,947 accounts) |
| --- | --- | --- |
| Median score | **85.3** | 42.5 |
| Share at ELITE or above | **61%** (17/28) | 11.3% |
| Median followers | 631 | 27 |
| Median merged PRs | 245 | 20 |
| Median account age | 8.4 years | 7.4 years |

The tier split is 7 GOD, 10 ELITE, 3 SOLID, 6 NPC, 2 TRASH. Among the 13 contributors with a full metric profile, not one account is younger than two years, none scores 3+ on the spam-bot heuristic (0.58% of accounts do site-wide), and only two accounts trip a red flag at all. Both trip "no original work" — people who write code for other people's projects and never start their own, which is hardly a defect here — and one of them also trips "mostly forks" and "social-only dormant profile". Site-wide, 17% of accounts trip at least one flag.

Nothing on this list is padded. For an AI project at the 80k-star mark that is not a throwaway sentence: among the [virally popular AI repos we have scanned](/blog/who-builds-openclaw), contributor lists stuffed with freshly registered accounts are not rare.

(Method note: this sample covers only the top 100 contributors by commit count — people who opened PRs without landing in that top 100 are excluded. The repo's [on-site profile](/developers/repo/lobehub/lobehub) lists only the contributors already on our leaderboard, a narrower sample, so its numbers differ from these.)

## Then the project: three years, three pivots

The other half of the case for LobeHub is that it is one of the rare projects that documents every architectural decision it later reversed.

**0.x (2023): local first.** Everything lived in the browser — no server database, one-click deploy, paste an API key and go. The price was no cross-device sync, no knowledge base, no scheduled tasks.

**1.0 (June 2024): add a server.** The team published "Towards LobeChat 1.0" in March 2024 laying out the trade-off, and shipped the server database and auth three months later. The license changed at the same time, from MIT to the custom LobeHub Community License.

**2.0 (announced November 2025): rename, and make the server the core.** The founder's write-up in GitHub Discussion #10007 is unusually candid: the 1.x split across browser, server and desktop fractured the experience, and the RSC architecture adopted early on meant that even lightweight interactions in a high-frequency chat UI paid a server round-trip. So 2.0 went back to an SPA, moved agent state, memory, knowledge and task execution onto the server, and renamed the product from LobeChat to LobeHub.

**CAO (May 2026): Chief Agent Operator.** Describe a goal in one sentence; it decomposes the work, spins up a squad of sub-agents, assigns tasks, and only stops when it genuinely needs your call.

The three pivots are one line: from "I operate an AI" to "I collaborate with a team of AIs" to "I manage a team of AIs". As the user's role moves up, the product's center of gravity moves from the client to the server.

## Three reasons to recommend it

**1. Model-neutral and self-hostable.** It talks to OpenAI, Anthropic, Google, DeepSeek, GLM and a long tail of others, with no middleman cut when you bring your own key; the hosted cloud is an option, not a prerequisite. For a team that wants a multi-model workbench without handing its chat history to a third party, there are not many alternatives.

**2. The shipping pace is real.** **790 PRs merged in the last 30 days** (7,498 all-time); 100 releases since 11 July, 38 of them in the last week. This is not a repo coasting on its star count.

**3. Design-engineering pedigree.** Founder arvinxx came out of the Ant Design core team, and another core contributor, canisminor1990 (score 90.1), lists both @lobehub and @ant-design in their bio. That lineage explains why, in a field crowded with functionally similar open-source AI clients, this one consistently looks and feels a tier better — and in this category, "looks good and gets out of the way" *is* the moat.

## Four things to be clear about

**1. The bus factor is low.** In the top-100 commit sample, arvinxx alone wrote **43.1%** of human commits; the top three wrote 62.6%, the top ten 88.2%. Over the last 30 days we sampled 400 merged PRs: 21 distinct authors, with the top five accounting for 83.8%. Translated: this is a company-team repo, not a distributed-community repo. It moves fast, but the speed sits in a handful of hands. (For contrast, on [Dify](/blog/who-builds-dify) the top committer accounts for just 8.4%.)

**2. The license is not MIT.** Since 1.0 it ships under the LobeHub Community License — Apache 2.0 plus two additional clauses. The text is explicit: using it commercially as a front-end and back-end service without modifying the source is fine, but "a commercial license must be obtained from the producer if you want to develop and distribute a derivative work". Contributors also agree that their code may be used commercially, including in the cloud edition. Personal use, internal deployment and as-is commercial use are all free; reskinning it and selling it is not. That is a legitimate choice — just know it before you build on top.

**3. The PR queue is much longer than the issue queue.** 245 issues are open and only 5 of them are older than three months, which is excellent triage. But 428 PRs are open and 124 of those are older than three months (renovate accounts for only 31). If you plan to contribute, calibrate: the core team merges its own branches at high speed; external PRs are a different clock.

**4. CAO is young.** 36Kr's May 2026 hands-on was headlined "four minutes to assemble the team, a whole day of crashes" — the team-assembly step genuinely impresses, but long-running execution is not yet something to depend on. Treat it as a direction taking shape, not a delivered capability.

## Who should pick it up

**Good fit:** small teams that want a self-hosted multi-model AI workbench; anyone looking for a mature agent platform to build internal tooling on (mind the license boundary); developers building in the agent/MCP plugin ecosystem who need a host with real users.

**Hold off if:** you need a stable API rather than a product; your organization requires a strictly permissive license; you expect community governance and fast merges for outside contributions.

## Three numbers we will keep watching

A recommendation is not a verdict — it is a call that later data can overturn. We will keep tracking three things in this repo: whether arvinxx's share of commits falls as the team grows; whether the median score of its scored contributors holds as the community widens; and whether that pile of PRs older than three months keeps growing. This pick holds up only as long as those three move the right way.

## References

1. [lobehub/lobehub · GitHub](https://github.com/lobehub/lobehub) (repo data collected 2026-08-04)
2. [LobeHub — Your Chief Agent Operator](https://lobehub.com/)
3. [Starting 2.0 of LobeHub(LobeChat): A System Reconstruction and Reflection · Discussion #10007](https://github.com/lobehub/lobehub/discussions/10007)
4. [Towards LobeChat 1.0](https://lobehub.com/blog/towards-lobe-chat-v1)
5. [LobeChat 1.0: a new architecture and new possibilities](https://lobehub.com/blog/release-lobe-chat-v1)
6. [LobeHub relicensed to Apache 2.0 (with commercial supplement)](https://lobehub.com/blog/lobe-chat-v1-license-update)
7. [CAO: your Chief Agent Operator · changelog](https://lobehub.com/changelog/2026-05-19-chief-agent-operator)
8. [36Kr: CAO on the job — four minutes to assemble the team, a whole day of crashes](https://m.36kr.com/p/3816272707280904)
9. [LobeHub plans and pricing](https://lobehub.com/pricing)
10. [The ghfind scoring methodology](/methodology)
