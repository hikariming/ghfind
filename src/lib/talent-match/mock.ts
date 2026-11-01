import type { CandidateReport } from "./types";

/**
 * The sample candidate report behind /talent-match's "View a sample report".
 * Every value is invented (people, scores, matches); repo star counts are
 * rounded placeholders. Real reports come from /api/talent-match/*.
 */

export const MOCK_CANDIDATE_REPORT: CandidateReport = {
  id: "demo-report",
  matchVersion: 1,
  createdAt: "2026-10-12T08:00:00Z",
  profile: {
    login: "demo-dev",
    name: "Lin Wei",
    headline: {
      zh: "LLM 推理与后端工程师，专注服务化与性能优化",
      en: "LLM inference & backend engineer focused on serving and performance",
    },
    direction: { zh: "AI 基础设施", en: "AI infrastructure" },
    years: 4,
    dimensions: {
      account_maturity: 8,
      original_project_quality: 12,
      contribution_quality: 17,
      ecosystem_impact: 9,
      community_influence: 4,
      activity_authenticity: 15,
    },
    skills: [
      { id: "python", label: "Python", level: 4, source: "verified", evidence: { zh: "142 个仓库中的主语言，3 个原创项目", en: "Primary language across 142 repos and 3 original projects" } },
      { id: "pytorch", label: "PyTorch", level: 3, source: "verified", evidence: { zh: "原创项目 fast-lora-serve 的核心依赖", en: "Core dependency of the original project fast-lora-serve" } },
      { id: "llm-inference", label: "LLM inference", level: 3, source: "verified", evidence: { zh: "向 vLLM 合并 4 个 PR（调度器与 KV cache）", en: "4 merged PRs to vLLM (scheduler and KV cache)" } },
      { id: "cuda", label: "CUDA", level: 2, source: "claimed", evidence: { zh: "简历：实现过 fused attention kernel", en: "Résumé: implemented a fused attention kernel" } },
      { id: "cpp", label: "C++", level: 2, source: "claimed", evidence: { zh: "简历：2 年 C++ 服务端开发", en: "Résumé: 2 years of C++ backend work" } },
      { id: "distributed-training", label: "Distributed training", level: 1, source: "claimed", evidence: { zh: "简历：参与过 8 卡微调", en: "Résumé: took part in 8-GPU fine-tuning" } },
      { id: "kubernetes", label: "Kubernetes", level: 3, source: "verified", evidence: { zh: "helm charts 与部署脚本仓库", en: "Repos with Helm charts and deployment tooling" } },
      { id: "go", label: "Go", level: 2, source: "verified", evidence: { zh: "2 个 Go 网关项目", en: "2 Go gateway projects" } },
    ],
    experience: [
      { title: { zh: "某云厂商 · 推理平台工程师", en: "Cloud provider · Inference platform engineer" }, detail: { zh: "2023 – 至今，负责多租户 LLM 推理服务", en: "2023 – present, multi-tenant LLM serving" }, source: "claimed" },
      { title: { zh: "某电商 · 后端工程师", en: "E-commerce company · Backend engineer" }, detail: { zh: "2021 – 2023，C++/Go 交易系统", en: "2021 – 2023, C++/Go trading systems" }, source: "claimed" },
    ],
    research: [],
    education: [
      { title: { zh: "计算机科学 硕士", en: "M.S. in Computer Science" }, detail: { zh: "国内 985 高校，2021 届", en: "Top-tier Chinese university, class of 2021" }, source: "claimed" },
    ],
    preferences: {
      location: { zh: "北京 / 杭州", en: "Beijing / Hangzhou" },
      remote: false,
      employment: { zh: "全职", en: "Full-time" },
    },
  },
  summary: {
    zh: "推理侧工程能力扎实且有开源证据（vLLM 合并 PR），后端与部署经验完整。短板集中在大规模分布式训练与 CUDA 的可验证证据，以及缺少顶会论文——这是冲击头部大模型公司训练岗的主要差距。",
    en: "Solid, open-source-backed inference engineering (merged vLLM PRs) with complete backend and deployment experience. The gaps are verifiable evidence of large-scale distributed training and CUDA, plus no top-venue papers — the main distance to training roles at frontier LLM labs.",
  },
  strengths: [
    { zh: "LLM 推理服务化：有被头部项目合并的代码", en: "LLM serving: code merged into a top project" },
    { zh: "工程落地完整：从模型服务到 K8s 部署", en: "End-to-end delivery: from model serving to K8s deployment" },
    { zh: "活跃度真实稳定，近两年持续提交", en: "Authentic, steady activity over the past two years" },
  ],
  matches: [
    {
      jobId: "demo-inference-engineer",
      company: "DeepSeek",
      title: { zh: "推理系统工程师", en: "Inference Systems Engineer" },
      location: { zh: "杭州", en: "Hangzhou" },
      fit: 82,
      reach: "high",
      breakdown: { mustHave: 88, niceToHave: 70, conditions: 75 },
      matched: ["Python", "PyTorch", "LLM inference", "C++"],
      gaps: [{ label: { zh: "CUDA kernel 的公开证据", en: "Public evidence of CUDA kernels" }, kind: "skill", cost: "low" }],
      reason: { zh: "核心要求几乎全部命中，且推理经验有 vLLM 合并 PR 作证。", en: "Hits nearly every core requirement, with merged vLLM PRs backing the inference experience." },
    },
    {
      jobId: "demo-training-engineer",
      company: "DeepSeek",
      title: { zh: "大模型训练工程师", en: "LLM Training Engineer" },
      location: { zh: "北京 / 杭州", en: "Beijing / Hangzhou" },
      fit: 58,
      reach: "medium",
      breakdown: { mustHave: 55, niceToHave: 20, conditions: 80 },
      matched: ["Python", "PyTorch", "C++"],
      gaps: [
        { label: { zh: "千卡级分布式训练（Megatron / DeepSpeed）", en: "Large-scale distributed training (Megatron / DeepSpeed)" }, kind: "skill", cost: "medium" },
        { label: { zh: "顶会论文（NeurIPS / ICML / MLSys）", en: "Top-venue papers (NeurIPS / ICML / MLSys)" }, kind: "research", cost: "high" },
        { label: { zh: "CUDA 达到熟练", en: "CUDA at a proficient level" }, kind: "skill", cost: "low" },
      ],
      reason: { zh: "工程底子匹配，但训练侧经验与科研产出是硬缺口。", en: "The engineering base fits, but training experience and research output are hard gaps." },
    },
    {
      jobId: "modaleap-ai-gateway-engineer",
      company: "ModaLeap",
      title: { zh: "AI 网关工程师", en: "AI Gateway Engineer" },
      location: { zh: "北京", en: "Beijing" },
      fit: 79,
      reach: "high",
      breakdown: { mustHave: 85, niceToHave: 60, conditions: 80 },
      matched: ["Go", "Kubernetes", "LLM inference"],
      gaps: [{ label: { zh: "API 网关限流 / 计费经验", en: "API gateway rate-limiting / billing" }, kind: "experience", cost: "low" }],
      reason: { zh: "Go + K8s + 推理服务的组合与岗位高度重合。", en: "Go + K8s + inference serving overlaps strongly with the role." },
    },
    {
      jobId: "modaleap-agent-engineer",
      company: "ModaLeap",
      title: { zh: "Agent 工程师", en: "Agent Engineer" },
      location: { zh: "北京", en: "Beijing" },
      fit: 64,
      reach: "medium",
      breakdown: { mustHave: 62, niceToHave: 55, conditions: 80 },
      matched: ["Python", "LLM inference"],
      gaps: [{ label: { zh: "Agent 框架与评测项目", en: "Agent frameworks and evaluation projects" }, kind: "experience", cost: "medium" }],
      reason: { zh: "LLM 基础扎实，缺少 Agent 方向的作品。", en: "Strong LLM fundamentals, but no agent-focused work yet." },
    },
  ],
  growth: [
    {
      kind: "open_source",
      title: { zh: "向 SGLang 贡献调度或 kernel 相关 PR", en: "Contribute scheduler or kernel PRs to SGLang" },
      detail: { zh: "你在 vLLM 调度器上的经验可直接迁移。先从 good first issue 中的性能回归入手，目标 3 个合并 PR。", en: "Your vLLM scheduler experience transfers directly. Start with performance regressions under good first issue; aim for 3 merged PRs." },
      repo: { fullName: "sgl-project/sglang", stars: 20000, language: "Python" },
      closes: [{ zh: "CUDA kernel 的公开证据", en: "Public evidence of CUDA kernels" }],
      horizon: { zh: "1–2 个月", en: "1–2 months" },
    },
    {
      kind: "open_source",
      title: { zh: "在 Megatron-LM 上复现并优化一个并行策略", en: "Reproduce and optimize a parallelism strategy in Megatron-LM" },
      detail: { zh: "选择流水线并行的气泡优化，写复现报告并提交 PR 或 issue 讨论，补上分布式训练的可验证证据。", en: "Pick pipeline-bubble reduction, publish a reproduction write-up and open a PR or issue — verifiable distributed-training evidence." },
      repo: { fullName: "NVIDIA/Megatron-LM", stars: 13000, language: "Python" },
      closes: [{ zh: "千卡级分布式训练（Megatron / DeepSpeed）", en: "Large-scale distributed training (Megatron / DeepSpeed)" }],
      horizon: { zh: "2–3 个月", en: "2–3 months" },
    },
    {
      kind: "portfolio",
      title: { zh: "开源一个可复现的 CUDA kernel 项目", en: "Open-source a reproducible CUDA kernel project" },
      detail: { zh: "把简历里的 fused attention 整理成独立仓库，附 benchmark 与对比，让 CUDA 从「自述」变为「已验证」。", en: "Turn the fused attention work on your résumé into a standalone repo with benchmarks, moving CUDA from claimed to verified." },
      closes: [{ zh: "CUDA 达到熟练", en: "CUDA at a proficient level" }],
      horizon: { zh: "3–4 周", en: "3–4 weeks" },
    },
    {
      kind: "research",
      title: { zh: "以 workshop 论文为起点进入科研轨道", en: "Enter research via a workshop paper" },
      detail: { zh: "顶会主会门槛高，可先把推理调度优化写成 MLSys / NeurIPS workshop 投稿，或与高校实验室合作。", en: "Main-track papers are a high bar; start by writing up your scheduling work for an MLSys / NeurIPS workshop, or collaborate with a university lab." },
      closes: [{ zh: "顶会论文（NeurIPS / ICML / MLSys）", en: "Top-venue papers (NeurIPS / ICML / MLSys)" }],
      horizon: { zh: "6–12 个月", en: "6–12 months" },
    },
    {
      kind: "skill",
      title: { zh: "系统学习分布式训练", en: "Study distributed training systematically" },
      detail: { zh: "按 DP → TP → PP → ZeRO 的顺序，配合小规模多卡实验，每一步留下可公开的笔记或代码。", en: "Work through DP → TP → PP → ZeRO with small multi-GPU experiments, leaving public notes or code at every step." },
      closes: [{ zh: "千卡级分布式训练（Megatron / DeepSpeed）", en: "Large-scale distributed training (Megatron / DeepSpeed)" }],
      horizon: { zh: "持续", en: "Ongoing" },
    },
  ],
};
