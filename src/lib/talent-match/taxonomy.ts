/**
 * Talent Match skill taxonomy: the closed id set both sides are extracted into
 * (candidate TalentProfile and JobRequirement), so one matcher serves both
 * directions. Extraction may only emit these ids; anything else becomes
 * {@link OTHER_SKILL}, is logged, and is reviewed to grow this list.
 *
 * Matching is by id only, so an alias must never point at two ids.
 */

export type SkillGroup =
  | "language"
  | "frontend"
  | "backend"
  | "mobile"
  | "ml"
  | "llm"
  | "infra"
  | "data"
  | "domain"
  | "practice";

export interface SkillDef {
  id: string;
  /** Display label; technology names are not translated. */
  label: string;
  /** Chinese label when it differs from `label`. */
  zh?: string;
  group: SkillGroup;
  /** Extra names that resolve to this id (GitHub linguist names, spellings). */
  aliases?: readonly string[];
}

export const OTHER_SKILL = "other";

export const SKILLS: readonly SkillDef[] = [
  // Languages (GitHub linguist names resolve here for verified evidence).
  { id: "python", label: "Python", group: "language", aliases: ["jupyter notebook", "py"] },
  { id: "typescript", label: "TypeScript", group: "language", aliases: ["ts"] },
  { id: "javascript", label: "JavaScript", group: "language", aliases: ["js", "ecmascript"] },
  { id: "go", label: "Go", group: "language", aliases: ["golang"] },
  { id: "rust", label: "Rust", group: "language" },
  { id: "java", label: "Java", group: "language" },
  { id: "kotlin", label: "Kotlin", group: "language" },
  { id: "scala", label: "Scala", group: "language" },
  { id: "cpp", label: "C++", group: "language", aliases: ["c++", "cplusplus", "cxx"] },
  { id: "c", label: "C", group: "language" },
  { id: "csharp", label: "C#", group: "language", aliases: ["c#", "c sharp"] },
  { id: "swift", label: "Swift", group: "language" },
  { id: "objective-c", label: "Objective-C", group: "language", aliases: ["objc"] },
  { id: "dart", label: "Dart", group: "language" },
  { id: "ruby", label: "Ruby", group: "language" },
  { id: "php", label: "PHP", group: "language" },
  { id: "elixir", label: "Elixir", group: "language" },
  { id: "haskell", label: "Haskell", group: "language" },
  { id: "zig", label: "Zig", group: "language" },
  { id: "julia", label: "Julia", group: "language" },
  { id: "r", label: "R", group: "language" },
  { id: "lua", label: "Lua", group: "language" },
  { id: "shell", label: "Shell", group: "language", aliases: ["bash", "zsh", "powershell"] },
  { id: "sql", label: "SQL", group: "language", aliases: ["plpgsql", "tsql"] },
  { id: "cuda", label: "CUDA", group: "language", aliases: ["cuda c++"] },
  { id: "triton", label: "Triton", group: "language", aliases: ["openai triton", "triton kernels"] },
  { id: "solidity", label: "Solidity", group: "language" },
  { id: "verilog", label: "Verilog", group: "language", aliases: ["systemverilog", "vhdl"] },

  // Frontend.
  { id: "react", label: "React", group: "frontend", aliases: ["react.js", "reactjs"] },
  { id: "vue", label: "Vue", group: "frontend", aliases: ["vue.js", "vuejs"] },
  { id: "svelte", label: "Svelte", group: "frontend", aliases: ["sveltekit"] },
  { id: "angular", label: "Angular", group: "frontend" },
  { id: "nextjs", label: "Next.js", group: "frontend", aliases: ["next.js", "next"] },
  { id: "css", label: "CSS", group: "frontend", aliases: ["tailwind", "tailwindcss", "scss", "sass"] },
  { id: "webgl", label: "WebGL", group: "frontend", aliases: ["three.js", "webgpu"] },
  { id: "web-performance", label: "Web performance", zh: "Web 性能优化", group: "frontend" },

  // Backend.
  { id: "nodejs", label: "Node.js", group: "backend", aliases: ["node.js", "node"] },
  { id: "spring", label: "Spring", group: "backend", aliases: ["spring boot"] },
  { id: "django", label: "Django", group: "backend" },
  { id: "fastapi", label: "FastAPI", group: "backend" },
  { id: "rails", label: "Rails", group: "backend", aliases: ["ruby on rails"] },
  { id: "dotnet", label: ".NET", group: "backend", aliases: [".net", "asp.net"] },
  { id: "grpc", label: "gRPC", group: "backend", aliases: ["protobuf"] },
  { id: "graphql", label: "GraphQL", group: "backend" },
  { id: "microservices", label: "Microservices", zh: "微服务", group: "backend" },
  { id: "high-concurrency", label: "High-concurrency systems", zh: "高并发系统", group: "backend", aliases: ["high concurrency"] },

  // Mobile.
  { id: "ios", label: "iOS", group: "mobile", aliases: ["swiftui", "uikit"] },
  { id: "android", label: "Android", group: "mobile", aliases: ["jetpack compose"] },
  { id: "flutter", label: "Flutter", group: "mobile" },
  { id: "react-native", label: "React Native", group: "mobile" },

  // Machine learning.
  { id: "pytorch", label: "PyTorch", group: "ml", aliases: ["torch"] },
  { id: "tensorflow", label: "TensorFlow", group: "ml", aliases: ["keras"] },
  { id: "jax", label: "JAX", group: "ml", aliases: ["flax"] },
  { id: "deep-learning", label: "Deep learning", zh: "深度学习", group: "ml" },
  { id: "machine-learning", label: "Machine learning", zh: "机器学习", group: "ml", aliases: ["ml", "scikit-learn", "sklearn"] },
  { id: "computer-vision", label: "Computer vision", zh: "计算机视觉", group: "ml", aliases: ["cv", "opencv"] },
  { id: "nlp", label: "NLP", zh: "自然语言处理", group: "ml", aliases: ["natural language processing"] },
  { id: "speech", label: "Speech", zh: "语音", group: "ml", aliases: ["asr", "tts"] },
  { id: "reinforcement-learning", label: "Reinforcement learning", zh: "强化学习", group: "ml", aliases: ["rl"] },
  { id: "recommender-systems", label: "Recommender systems", zh: "推荐系统", group: "ml", aliases: ["recommendation", "recsys"] },
  { id: "multimodal", label: "Multimodal models", zh: "多模态", group: "ml", aliases: ["multimodal", "vlm"] },
  { id: "diffusion-models", label: "Diffusion models", zh: "扩散模型", group: "ml", aliases: ["stable diffusion"] },

  // LLM-specific.
  { id: "llm-training", label: "LLM training", zh: "大模型训练", group: "llm", aliases: ["pretraining", "llm pretraining"] },
  { id: "distributed-training", label: "Distributed training", zh: "分布式训练", group: "llm", aliases: ["megatron", "megatron-lm", "deepspeed", "fsdp"] },
  { id: "llm-inference", label: "LLM inference", zh: "大模型推理", group: "llm", aliases: ["vllm", "sglang", "tensorrt-llm", "llm serving", "lmdeploy", "llama.cpp"] },
  { id: "gpu-kernels", label: "GPU kernels", zh: "GPU 算子开发", group: "llm", aliases: ["cutlass", "kernel optimization"] },
  { id: "fine-tuning", label: "Fine-tuning", zh: "微调", group: "llm", aliases: ["lora", "sft", "peft", "llama-factory", "unsloth", "axolotl"] },
  { id: "rlhf", label: "RLHF / post-training", zh: "RLHF / 后训练", group: "llm", aliases: ["post-training", "dpo", "grpo", "trl", "openrlhf", "verl"] },
  { id: "rag", label: "RAG", group: "llm", aliases: ["retrieval augmented generation"] },
  { id: "llm-agents", label: "LLM agents", zh: "智能体", group: "llm", aliases: ["agent", "agents", "ai agent", "langchain", "llamaindex", "openhands", "autogen", "swe-agent"] },
  { id: "prompt-engineering", label: "Prompt engineering", zh: "提示工程", group: "llm" },
  { id: "llm-evaluation", label: "LLM evaluation", zh: "大模型评测", group: "llm", aliases: ["evals", "benchmarking llms", "lm-evaluation-harness", "opencompass"] },
  { id: "model-compression", label: "Model compression", zh: "模型压缩", group: "llm", aliases: ["quantization", "distillation", "pruning"] },

  // Infrastructure.
  { id: "kubernetes", label: "Kubernetes", group: "infra", aliases: ["k8s", "helm"] },
  { id: "docker", label: "Docker", group: "infra", aliases: ["containers", "dockerfile"] },
  { id: "linux", label: "Linux", group: "infra", aliases: ["linux kernel"] },
  { id: "aws", label: "AWS", group: "infra", aliases: ["amazon web services"] },
  { id: "gcp", label: "GCP", group: "infra", aliases: ["google cloud"] },
  { id: "azure", label: "Azure", group: "infra" },
  { id: "terraform", label: "Terraform", group: "infra", aliases: ["hcl", "pulumi"] },
  { id: "ci-cd", label: "CI/CD", group: "infra", aliases: ["github actions", "jenkins", "gitlab ci"] },
  { id: "observability", label: "Observability", zh: "可观测性", group: "infra", aliases: ["prometheus", "grafana", "opentelemetry"] },
  { id: "networking", label: "Networking", zh: "网络", group: "infra", aliases: ["tcp/ip", "rdma", "nccl"] },
  { id: "distributed-systems", label: "Distributed systems", zh: "分布式系统", group: "infra" },
  { id: "storage-systems", label: "Storage systems", zh: "存储系统", group: "infra", aliases: ["file systems"] },
  { id: "gpu-cluster", label: "GPU cluster operations", zh: "GPU 集群运维", group: "infra", aliases: ["slurm", "gpu scheduling"] },
  { id: "compilers", label: "Compilers", zh: "编译器", group: "infra", aliases: ["llvm", "mlir", "tvm"] },
  { id: "operating-systems", label: "Operating systems", zh: "操作系统", group: "infra" },
  { id: "webassembly", label: "WebAssembly", group: "infra", aliases: ["wasm"] },

  // Data.
  { id: "postgresql", label: "PostgreSQL", group: "data", aliases: ["postgres"] },
  { id: "mysql", label: "MySQL", group: "data", aliases: ["mariadb"] },
  { id: "redis", label: "Redis", group: "data" },
  { id: "mongodb", label: "MongoDB", group: "data", aliases: ["mongo"] },
  { id: "elasticsearch", label: "Elasticsearch", group: "data", aliases: ["opensearch"] },
  { id: "kafka", label: "Kafka", group: "data", aliases: ["pulsar"] },
  { id: "spark", label: "Spark", group: "data", aliases: ["pyspark"] },
  { id: "flink", label: "Flink", group: "data" },
  { id: "data-engineering", label: "Data engineering", zh: "数据工程", group: "data", aliases: ["etl", "airflow"] },
  { id: "vector-databases", label: "Vector databases", zh: "向量数据库", group: "data", aliases: ["milvus", "pgvector", "faiss"] },
  { id: "database-internals", label: "Database internals", zh: "数据库内核", group: "data" },

  // Domains.
  { id: "security", label: "Security", zh: "安全", group: "domain", aliases: ["appsec", "cybersecurity"] },
  { id: "blockchain", label: "Blockchain", zh: "区块链", group: "domain", aliases: ["web3", "ethereum"] },
  { id: "game-dev", label: "Game development", zh: "游戏开发", group: "domain", aliases: ["unity", "unreal engine", "godot"] },
  { id: "embedded", label: "Embedded systems", zh: "嵌入式", group: "domain", aliases: ["firmware", "rtos"] },
  { id: "robotics", label: "Robotics", zh: "机器人", group: "domain", aliases: ["ros"] },
  { id: "autonomous-driving", label: "Autonomous driving", zh: "自动驾驶", group: "domain" },
  { id: "hpc", label: "High-performance computing", zh: "高性能计算", group: "domain", aliases: ["mpi", "openmp"] },
  { id: "devtools", label: "Developer tools", zh: "开发者工具", group: "domain", aliases: ["cli tools", "ide plugins"] },

  // Practices.
  { id: "open-source-maintenance", label: "Open-source maintenance", zh: "开源维护", group: "practice" },
  { id: "system-design", label: "System design", zh: "系统设计", group: "practice", aliases: ["architecture"] },
  { id: "performance-optimization", label: "Performance optimization", zh: "性能优化", group: "practice", aliases: ["profiling"] },
  { id: "testing", label: "Testing", zh: "测试", group: "practice", aliases: ["unit testing", "e2e testing"] },
  { id: "technical-writing", label: "Technical writing", zh: "技术写作", group: "practice", aliases: ["documentation"] },
  { id: "team-leadership", label: "Team leadership", zh: "团队管理", group: "practice", aliases: ["tech lead", "engineering management"] },
];

const BY_ID = new Map(SKILLS.map((skill) => [skill.id, skill]));

/** Case-, space- and hyphen-insensitive key, keeping symbols like "c++" / ".net". */
export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

const BY_NAME = (() => {
  const index = new Map<string, string>();
  for (const skill of SKILLS) {
    for (const name of [skill.id, skill.label, skill.zh, ...(skill.aliases ?? [])]) {
      if (!name) continue;
      const key = normalizeSkillName(name);
      const existing = index.get(key);
      if (existing && existing !== skill.id) {
        throw new Error(`skill name "${name}" maps to both ${existing} and ${skill.id}`);
      }
      index.set(key, skill.id);
    }
  }
  return index;
})();

export function isSkillId(id: string): boolean {
  return BY_ID.has(id);
}

/** Resolve an id, label, Chinese label or alias to its id; null when unknown. */
export function resolveSkill(name: string): string | null {
  return BY_NAME.get(normalizeSkillName(name)) ?? null;
}

export function skillGroup(id: string): SkillGroup | null {
  return BY_ID.get(id)?.group ?? null;
}

export function skillLabel(id: string, zh = false): string {
  const skill = BY_ID.get(id);
  if (!skill) return id;
  return zh ? skill.zh ?? skill.label : skill.label;
}

/** Compact `id: label` lines for the extraction prompt's closed vocabulary. */
export function skillVocabulary(): string {
  return SKILLS.map((skill) => `${skill.id}: ${skill.label}`).join("\n");
}
