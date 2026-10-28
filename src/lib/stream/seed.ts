import type { StreamItem, StreamKind } from "./types";
import type { XAccount, XPost, XTimeline } from "./x";

/**
 * Demo items for the /feed prototype when no live source answers (local dev
 * without D1/KV bindings). Fictional owners only, like lib/home-mocks.ts.
 */
type Seed = {
  kind: StreamKind;
  slug: string;
  title: [zh: string, en: string];
  summary: [zh: string, en: string];
  author: string;
  tags: string[];
  score?: number;
  scoreLabel?: string;
  days: number;
  quality: number;
  minutes?: number;
  sponsored?: boolean;
};

const SEEDS: Seed[] = [
  { kind: "project", slug: "demo/observatory", title: ["observatory", "observatory"], summary: ["让复杂生产系统一眼看懂：一条命令拉起链路追踪 + 指标面板。", "Make production systems legible: tracing and metrics in one command."], author: "demo", tags: ["observability", "developer-tools", "TypeScript"], score: 82, days: 2, quality: 0.82 },
  { kind: "developer", slug: "demo-maintainer", title: ["Demo Maintainer", "Demo Maintainer"], summary: ["Rust · 编译器 · 长期维护者", "Rust · compilers · long-term maintainer"], author: "demo-maintainer", tags: ["Rust", "compilers"], score: 91, scoreLabel: "god", days: 1, quality: 0.91 },
  { kind: "article", slug: "how-scores-work", title: ["我们如何给 GitHub 账号打分", "How we score GitHub accounts"], summary: ["从贡献深度到刷量识别：评分模型的每一个权重都公开在这里。", "From contribution depth to spam detection: every weight in the model, explained."], author: "ghfind", tags: ["methodology", "scoring"], days: 9, quality: 0.86, minutes: 7 },
  { kind: "talent", slug: "talent-ada", title: ["Ada L.", "Ada L."], summary: ["5 年 Infra 经验，主导过两个 2k★ 开源项目，正在看 AI Infra 机会。", "5 years of infra, led two 2k★ OSS projects, open to AI infra roles."], author: "ada-demo", tags: ["AI Infra", "Go", "Kubernetes"], score: 86, scoreLabel: "available", days: 3, quality: 0.84 },
  { kind: "project", slug: "sample/flowkit", title: ["flowkit", "flowkit"], summary: ["给小团队的可组合工作流：YAML 写流程，Git 管版本。", "Composable workflows for small teams: YAML flows, versioned in Git."], author: "sample", tags: ["workflow", "automation", "Go"], score: 74, days: 5, quality: 0.74 },
  { kind: "collection", slug: "agent-picks", title: ["本周 Agent 项目精选 10 个", "10 agent projects worth your weekend"], summary: ["从 MCP 工具到沙箱运行时，编辑逐个跑过的 10 个项目。", "From MCP tools to sandbox runtimes: ten projects our editors actually ran."], author: "ghfind", tags: ["agent", "projects"], days: 4, quality: 0.8, minutes: 5 },
  { kind: "developer", slug: "sample-builder", title: ["Sample Builder", "Sample Builder"], summary: ["TypeScript · 前端基建 · 本周进步 +12", "TypeScript · frontend infra · +12 this week"], author: "sample-builder", tags: ["TypeScript", "frontend"], score: 84, scoreLabel: "elite", days: 2, quality: 0.84 },
  { kind: "job", slug: "acme-ai-infra", title: ["AI Infra 工程师", "AI Infra Engineer"], summary: ["远程 · 全职 · 负责推理集群调度与成本优化。", "Remote · full-time · own inference scheduling and cost."], author: "Acme Labs", tags: ["AI Infra", "full_time"], scoreLabel: "40-70k", days: 1, quality: 0.6, sponsored: true },
  { kind: "project", slug: "fictional-owner-lathe/lathe", title: ["lathe", "lathe"], summary: ["本地夹具与布局检查的 CLI 生成器，10 秒出一套 e2e 骨架。", "A CLI that scaffolds local fixtures and layout checks in ten seconds."], author: "fictional-owner-lathe", tags: ["cli", "codegen", "testing"], score: 69, days: 12, quality: 0.69 },
  { kind: "talent", slug: "talent-kai", title: ["Kai W.", "Kai W."], summary: ["独立开发者，做过 3 个付费 SaaS，擅长从 0 到 1。", "Indie hacker, shipped 3 paid SaaS products, strong at zero-to-one."], author: "kai-demo", tags: ["Full-stack", "Next.js", "SaaS"], score: 79, days: 6, quality: 0.78 },
  { kind: "article", slug: "19000-accounts", title: ["我们给 19000 个 GitHub 账号打了分", "We scored 19,000 GitHub accounts"], summary: ["分数分布、语言偏好、刷量特征——数据里有很多反直觉的发现。", "Score distribution, languages, spam signals — the data has surprises."], author: "ghfind", tags: ["data", "scoring"], days: 20, quality: 0.88, minutes: 9 },
  { kind: "project", slug: "demo/sandboxd", title: ["sandboxd", "sandboxd"], summary: ["给 Agent 用的一次性沙箱，冷启动 80ms。", "Disposable sandboxes for agents with an 80ms cold start."], author: "demo", tags: ["agent", "sandbox", "Rust"], score: 88, days: 1, quality: 0.88 },
  { kind: "developer", slug: "npc-coder", title: ["NPC Coder", "NPC Coder"], summary: ["Python · 数据工程", "Python · data engineering"], author: "npc-coder", tags: ["Python", "data"], score: 58, scoreLabel: "npc", days: 3, quality: 0.58 },
  { kind: "collection", slug: "who-builds-dify", title: ["谁在构建 Dify？", "Who builds Dify?"], summary: ["拆解一个明星项目背后的贡献者网络。", "The contributor network behind a breakout project."], author: "ghfind", tags: ["developers", "agent"], days: 15, quality: 0.82, minutes: 6 },
  { kind: "job", slug: "nova-frontend", title: ["高级前端工程师", "Senior Frontend Engineer"], summary: ["上海 · 全职 · 设计系统与编辑器方向。", "Shanghai · full-time · design systems and editors."], author: "Nova Studio", tags: ["frontend", "full_time"], scoreLabel: "35-55k", days: 4, quality: 0.6, sponsored: true },
  { kind: "project", slug: "sample/mcp-lens", title: ["mcp-lens", "mcp-lens"], summary: ["抓包级 MCP 调试器，看清每一次工具调用。", "A packet-level MCP debugger: see every tool call."], author: "sample", tags: ["agent", "mcp", "developer-tools"], score: 80, days: 3, quality: 0.8 },
];

const DAY = 86_400_000;

export function seedStreamItems(lang: "zh" | "en", now: number): StreamItem[] {
  const pick = (pair: [string, string]) => (lang === "zh" ? pair[0] : pair[1]);
  return SEEDS.map((seed) => {
    const id = `${seed.kind}:demo:${seed.slug}`;
    const isPerson = seed.kind === "developer" || seed.kind === "talent";
    const login = isPerson ? seed.slug : seed.author;
    return {
      id,
      kind: seed.kind,
      title: pick(seed.title),
      summary: pick(seed.summary),
      body: null,
      author: {
        id: seed.kind === "job" ? `company:${seed.author}` : login,
        name: seed.kind === "job" ? seed.author : isPerson ? pick(seed.title) : seed.author,
        avatarUrl: seed.author === "ghfind" ? "/icon.svg" : null,
        handle: seed.kind === "job" ? null : `@${login}`,
      },
      coverUrl: null,
      tags: seed.tags,
      score: seed.score ?? null,
      scoreLabel: seed.scoreLabel ?? null,
      stats: [],
      href: "#",
      external: false,
      publishedAt: seed.kind === "article" || seed.kind === "collection" ? new Date(now - seed.days * DAY).toISOString() : null,
      readingMinutes: seed.minutes ?? null,
      sponsored: seed.sponsored ?? false,
      quality: seed.quality,
      heat: seed.quality * 0.6,
      counter: null,
      badge: seed.kind === "collection" ? "editor" : null,
      comments: null,
      extra: null,
    };
  });
}

/**
 * Demo X timeline for non-production deployments until the operator agent
 * pushes real posts. Every account and post is fictional (no real person is
 * quoted); the UI labels the set as demo data. One account links to the demo
 * developer above so the profile ↔ X linking is visible locally.
 */
export function seedXTimeline(now: number): XTimeline {
  const hours = (value: number) => new Date(now - value * 3_600_000).toISOString();
  const account = (handle: string, name: string, category: XAccount["category"], github: string | null = null, ghfind: XAccount["ghfind"] = null): XAccount => ({
    handle, name, category, github, talentId: null, verified: true, avatarUrl: null, note: null, ghfind, source: github ? "score" : "editorial",
  });
  let sequence = 0;
  const post = (handle: string, text: string, at: number, topics: string[], metrics: [number, number, number, number], extra: Partial<XPost> = {}): XPost => {
    sequence += 1;
    const id = `19000000000000${String(sequence).padStart(5, "0")}`;
    return {
      id, handle, text, createdAt: hours(at), url: `https://x.com/${handle}/status/${id}`, kind: "post",
      metrics: { likes: metrics[0], reposts: metrics[1], replies: metrics[2], views: metrics[3] },
      media: null, quote: null, topics, technical: 0.9, lang: /[\u4e00-\u9fff]/.test(text) ? "zh" : "en",
      translations: DEMO_TRANSLATIONS[sequence] ?? {}, ...extra,
    };
  };
  return {
    updatedAt: now,
    accounts: [
      account("demo_researcher", "Demo Researcher", "researcher"),
      account("demo_lab_cn", "示例 AI 实验室", "researcher"),
      account("demo_builder", "Demo Builder", "builder"),
      account("demo_founder_cn", "示例创始人", "builder"),
      account("demo_media", "Demo Tech Weekly", "media"),
      account("demo_media_cn", "示例科技观察", "media"),
      account("demo_maintainer", "Demo Maintainer", "developer", "demo-maintainer", { score: 91, tier: "god" }),
      account("demo_infra_dev", "Demo Infra Dev", "developer", "demo-infra-dev", { score: 86, tier: "elite" }),
    ],
    posts: [
      post("demo_researcher", "We trained a 1B model with half the tokens by filtering for code that compiles and passes its own tests. Data quality beats data quantity again — ablations and the filter script in the paper.", 2, ["LLM", "data quality"], [2400, 380, 120, 210000]),
      post("demo_lab_cn", "我们把长上下文评测从 128k 拉到 1M token 后发现：大多数模型的「找针」分数很好看，但在多跳推理上掉得很厉害。评测集和复现脚本已开源，欢迎拍砖。", 4, ["长上下文", "评测"], [1800, 420, 160, 150000]),
      post("demo_maintainer", "Shipped incremental parsing in our Rust compiler front-end today. Re-check of a 40k-line crate after a one-line edit went from 2.1s to 90ms. Write-up on how we kept the red-green tree cache coherent:", 6, ["Rust", "compilers"], [860, 140, 45, 64000], {
        quote: { author: "demo-maintainer", text: "Incremental parsing in practice: red-green trees, cache invalidation and what broke.", url: "https://example.com/incremental-parsing" },
      }),
      post("demo_builder", "Hard-won lesson from running agents in production: give them a sandbox that boots in <100ms and they stop trying to be clever with the host. Our failure rate dropped 60% after we moved every tool call into a disposable VM.", 8, ["agents", "infra"], [1500, 210, 98, 120000]),
      post("demo_founder_cn", "做开发者工具三年的一个体会：用户不会因为你的功能多而留下，只会因为「第一次 5 分钟就跑通」而留下。我们把安装步骤从 7 步砍到 1 条命令后，次周留存翻了一倍。", 10, ["开发者工具", "增长"], [960, 230, 88, 72000]),
      post("demo_infra_dev", "Postmortem from last week's outage is up. Root cause: a retry storm between two services that both had \"safe\" exponential backoff, just with the same jitter seed. Fix was one line; finding it took 9 hours.", 12, ["SRE", "distributed systems"], [740, 160, 52, 58000]),
      post("demo_media", "New issue: how three open-source inference engines handle KV-cache eviction under load, with benchmarks on the same hardware and the configs to reproduce.", 14, ["inference", "benchmarks"], [420, 90, 12, 38000]),
      post("demo_media_cn", "本周开源观察：一个只有 3 位维护者的向量数据库项目，Star 两周涨了 1.2 万。我们拆了它的代码和 issue 区，聊聊它为什么能火、以及接下来最可能踩的坑。", 16, ["开源", "数据库"], [530, 140, 40, 46000]),
      post("demo_researcher", "Reminder that a 2-point benchmark gain is often inside run-to-run noise. We re-ran 5 popular evals with 10 seeds each — the std dev is bigger than most reported improvements. Please report variance.", 20, ["evaluation", "ML research"], [3100, 640, 210, 260000]),
      post("demo_maintainer", "PSA for library authors: semver-major for a type-only change is fine. Your users' CI breaking on a minor bump is not.", 26, ["open source", "Rust"], [1200, 260, 130, 90000]),
      post("demo_lab_cn", "小模型也能做好工具调用：我们用 3B 模型 + 结构化解码，在内部函数调用基准上追平了 70B 基线，延迟降到 1/8。训练数据构造方法写在技术报告第 4 节。", 30, ["小模型", "工具调用"], [1350, 300, 76, 110000]),
      post("demo_builder", "Unpopular opinion: most teams don't need a vector DB on day one. Postgres + pgvector carried us to 40M embeddings before we felt any pain. Measure first.", 36, ["databases", "RAG"], [2100, 350, 290, 180000]),
      post("demo_infra_dev", "Wrote a tiny eBPF tool that attributes every TCP retransmit to the Kubernetes pod that caused it. Took our \"network is slow\" tickets from days to minutes. Open-sourcing it this week.", 44, ["eBPF", "Kubernetes"], [880, 190, 34, 61000]),
      post("demo_founder_cn", "招聘上的一个反直觉：我们最好的几位工程师，简历都很普通，但 GitHub 上都有一个维护了两年以上、没什么人用、却写得很认真的项目。", 52, ["招聘", "工程文化"], [1650, 410, 190, 130000]),
    ],
  };
}

/**
 * Demo translations by post order in seedXTimeline (1-based), standing in
 * for what the operator agent sends. Six posts carry every site locale; the
 * rest only the zh/en counterpart.
 */
const DEMO_TRANSLATIONS: Record<number, Partial<Record<string, string>>> = {
  1: {
    zh: "我们只挑「能编译、且能通过自身测试」的代码做数据，用一半的 token 训出了一个 1B 模型。数据质量又一次赢了数据数量——消融实验和过滤脚本都在论文里。",
    ja: "コンパイルが通り、自身のテストにも合格するコードだけに絞り込むことで、半分のトークンで 1B モデルを学習しました。またしてもデータの量より質。アブレーションとフィルタスクリプトは論文に。",
    ko: "컴파일되고 자체 테스트까지 통과하는 코드만 걸러서, 절반의 토큰으로 1B 모델을 학습했습니다. 이번에도 데이터의 양보다 질이 이겼습니다. 어블레이션과 필터 스크립트는 논문에 있습니다.",
    es: "Entrenamos un modelo de 1B con la mitad de tokens filtrando solo código que compila y pasa sus propios tests. La calidad de los datos vuelve a ganarle a la cantidad: ablaciones y script de filtrado en el paper.",
    pt: "Treinamos um modelo de 1B com metade dos tokens filtrando apenas código que compila e passa nos próprios testes. Qualidade de dados vence quantidade de novo — ablações e o script de filtro estão no paper.",
    id: "Kami melatih model 1B dengan separuh token dengan hanya menyaring kode yang bisa dikompilasi dan lolos tesnya sendiri. Kualitas data lagi-lagi mengalahkan kuantitas — ablasi dan skrip filternya ada di paper.",
    vi: "Chúng tôi huấn luyện mô hình 1B với một nửa số token bằng cách chỉ giữ lại mã biên dịch được và vượt qua chính bộ test của nó. Chất lượng dữ liệu lại thắng số lượng — ablation và script lọc có trong bài báo.",
    ar: "درّبنا نموذجًا بحجم 1B بنصف عدد الرموز عبر تصفية الشيفرة التي تُترجَم وتجتاز اختباراتها فقط. جودة البيانات تتفوّق على كميتها مجددًا، والتجارب وسكربت التصفية في الورقة.",
  },
  2: {
    en: "After stretching our long-context eval from 128k to 1M tokens: most models still score well on needle-in-a-haystack, but drop sharply on multi-hop reasoning. Eval set and repro scripts are open source — critique welcome.",
    ja: "長文脈評価を 128k から 1M トークンまで伸ばしたところ、多くのモデルは「針探し」では高得点のままでも、マルチホップ推論では大きく落ちました。評価セットと再現スクリプトは公開済み、ご批判歓迎です。",
    ko: "장문 컨텍스트 평가를 128k에서 1M 토큰으로 늘려 보니, 대부분의 모델이 '바늘 찾기'에서는 여전히 점수가 좋지만 멀티홉 추론에서는 크게 떨어졌습니다. 평가셋과 재현 스크립트는 공개했으니 의견 환영합니다.",
    es: "Al ampliar nuestra evaluación de contexto largo de 128k a 1M tokens: la mayoría de los modelos sigue puntuando bien en «aguja en un pajar», pero cae mucho en razonamiento multi-salto. El conjunto de evaluación y los scripts son open source.",
    pt: "Ao estender nossa avaliação de contexto longo de 128k para 1M tokens: a maioria dos modelos continua indo bem em “agulha no palheiro”, mas cai muito em raciocínio multi-etapas. Conjunto de avaliação e scripts são open source.",
    id: "Setelah memperluas evaluasi konteks panjang dari 128k ke 1M token: sebagian besar model tetap bagus di uji \"jarum dalam jerami\", tapi anjlok di penalaran multi-langkah. Set evaluasi dan skrip reproduksinya open source.",
    vi: "Khi kéo bài đánh giá ngữ cảnh dài từ 128k lên 1M token: đa số mô hình vẫn đạt điểm tốt ở bài \"mò kim đáy bể\", nhưng tụt mạnh ở suy luận nhiều bước. Bộ đánh giá và script tái lập đã được mở mã nguồn.",
    ar: "بعد توسيع تقييم السياق الطويل من 128 ألفًا إلى مليون رمز: ما زالت معظم النماذج تحقق نتائج جيدة في «الإبرة في كومة القش»، لكنها تتراجع بشدة في الاستدلال متعدد الخطوات. مجموعة التقييم والسكربتات مفتوحة المصدر.",
  },
  3: { zh: "今天给我们的 Rust 编译器前端上线了增量解析。4 万行的 crate 改一行后重新检查，从 2.1 秒降到 90 毫秒。写了篇文章讲我们如何让红绿树缓存保持一致：" },
  4: {
    zh: "在生产环境跑 Agent 的血泪教训：给它一个 100 毫秒内就能启动的沙箱，它就不会再对宿主机耍小聪明。把每次工具调用都挪进一次性虚拟机后，我们的失败率下降了 60%。",
    ja: "本番でエージェントを運用して得た教訓：100ms 以内に起動するサンドボックスを与えれば、ホストで小細工をしなくなる。すべてのツール呼び出しを使い捨て VM に移したら、失敗率が 60% 下がりました。",
    ko: "프로덕션에서 에이전트를 돌리며 얻은 교훈: 100ms 안에 뜨는 샌드박스를 주면 호스트에서 잔꾀를 부리지 않습니다. 모든 도구 호출을 일회용 VM으로 옮긴 뒤 실패율이 60% 줄었습니다.",
    es: "Lección aprendida operando agentes en producción: dales un sandbox que arranque en menos de 100 ms y dejan de hacerse los listos con el host. Nuestra tasa de fallos bajó un 60% al mover cada llamada a herramienta a una VM desechable.",
    pt: "Lição aprendida rodando agentes em produção: dê a eles um sandbox que sobe em menos de 100 ms e eles param de tentar ser espertos com o host. Nossa taxa de falhas caiu 60% ao mover cada chamada de ferramenta para uma VM descartável.",
    id: "Pelajaran dari menjalankan agen di produksi: beri mereka sandbox yang menyala di bawah 100 ms, maka mereka berhenti \"akal-akalan\" di host. Tingkat kegagalan kami turun 60% setelah semua pemanggilan tool dipindah ke VM sekali pakai.",
    vi: "Bài học xương máu khi chạy agent trên production: cho chúng một sandbox khởi động dưới 100ms là chúng thôi giở trò với máy chủ. Tỉ lệ lỗi của chúng tôi giảm 60% sau khi chuyển mọi lần gọi công cụ vào VM dùng một lần.",
    ar: "درس صعب من تشغيل الوكلاء في بيئة الإنتاج: امنحهم بيئة معزولة تقلع في أقل من 100 ملّي ثانية وسيتوقفون عن التحايل على الخادم. انخفض معدل الإخفاق لدينا 60% بعد نقل كل استدعاء أداة إلى آلة افتراضية مؤقتة.",
  },
  5: { en: "One lesson from three years of building developer tools: users don't stay because you have more features — they stay because it worked in the first 5 minutes. Cutting install from 7 steps to one command doubled our week-two retention." },
  6: { zh: "上周故障的复盘已发布。根因：两个服务都配了「安全」的指数退避，却用了同一个抖动种子，结果引发重试风暴。修复只有一行，定位花了 9 个小时。" },
  7: { zh: "新一期：三款开源推理引擎在高负载下如何处理 KV-cache 淘汰，同一硬件上的基准测试，附可复现配置。" },
  8: { en: "Open-source watch: a vector database with only 3 maintainers gained 12k stars in two weeks. We dug through its code and issues — why it took off, and the pitfalls it's most likely to hit next." },
  9: {
    zh: "提醒一下：基准上 2 个点的提升，常常落在多次运行的噪声范围内。我们对 5 个常用评测各跑了 10 个随机种子——标准差比大多数论文报告的提升还大。请报告方差。",
    ja: "念のため：ベンチマークでの 2 ポイント向上は、実行ごとのノイズの範囲内であることが多いです。主要な 5 つの評価をシード 10 個ずつで再実行したところ、標準偏差は報告される改善幅の多くより大きかった。分散も報告しましょう。",
    ko: "다시 한번: 벤치마크 2점 향상은 실행할 때마다 생기는 노이즈 범위 안인 경우가 많습니다. 자주 쓰는 평가 5개를 시드 10개씩 다시 돌려 보니, 표준편차가 보고된 개선 폭 대부분보다 컸습니다. 분산도 함께 보고해 주세요.",
    es: "Recordatorio: una mejora de 2 puntos en un benchmark suele estar dentro del ruido entre ejecuciones. Repetimos 5 evaluaciones populares con 10 semillas cada una: la desviación estándar es mayor que la mayoría de las mejoras publicadas. Reporten la varianza.",
    pt: "Lembrete: um ganho de 2 pontos num benchmark muitas vezes está dentro do ruído entre execuções. Rodamos 5 avaliações populares com 10 seeds cada — o desvio padrão é maior que a maioria das melhorias publicadas. Reportem a variância.",
    id: "Pengingat: kenaikan 2 poin di benchmark sering masih dalam rentang noise antar-run. Kami menjalankan ulang 5 evaluasi populer dengan masing-masing 10 seed — standar deviasinya lebih besar dari kebanyakan peningkatan yang dilaporkan. Tolong laporkan variansnya.",
    vi: "Nhắc nhở: mức tăng 2 điểm trên benchmark thường nằm trong nhiễu giữa các lần chạy. Chúng tôi chạy lại 5 bài đánh giá phổ biến, mỗi bài 10 seed — độ lệch chuẩn còn lớn hơn phần lớn mức cải thiện được công bố. Hãy báo cáo phương sai.",
    ar: "تذكير: تحسّن بمقدار نقطتين في معيار ما يقع غالبًا ضمن ضجيج التشغيل المتكرر. أعدنا تشغيل 5 تقييمات شائعة بعشر بذور لكل منها، وكان الانحراف المعياري أكبر من معظم التحسينات المنشورة. رجاءً انشروا التباين.",
  },
  10: { zh: "给库作者的提醒：只改类型也发大版本，没问题。让用户的 CI 因为一个小版本升级而挂掉，才是问题。" },
  11: { en: "Small models can do tool calling well: a 3B model with structured decoding matched our 70B baseline on an internal function-calling benchmark at 1/8 the latency. How we built the training data is in section 4 of the report." },
  12: {
    zh: "不太主流的观点：大多数团队第一天并不需要向量数据库。Postgres + pgvector 撑到了 4000 万条向量我们才感觉到压力。先测量，再决定。",
    ja: "少数派の意見：ほとんどのチームは初日からベクトル DB を必要としていない。Postgres + pgvector で 4,000 万件の埋め込みまで問題なく運用できました。まず計測を。",
    ko: "인기 없는 의견: 대부분의 팀은 첫날부터 벡터 DB가 필요하지 않습니다. Postgres + pgvector로 임베딩 4천만 개까지 아무 문제 없이 버텼습니다. 먼저 측정하세요.",
    es: "Opinión impopular: la mayoría de los equipos no necesita una base de datos vectorial el primer día. Postgres + pgvector nos llevó hasta 40 millones de embeddings sin problemas. Mide primero.",
    pt: "Opinião impopular: a maioria dos times não precisa de um banco vetorial no primeiro dia. Postgres + pgvector nos levou a 40 milhões de embeddings sem dor. Meça primeiro.",
    id: "Opini tidak populer: kebanyakan tim tidak butuh vector DB di hari pertama. Postgres + pgvector sanggup sampai 40 juta embedding sebelum kami merasa kesulitan. Ukur dulu.",
    vi: "Ý kiến không được lòng số đông: hầu hết đội ngũ không cần cơ sở dữ liệu vector ngay ngày đầu. Postgres + pgvector chịu được tới 40 triệu embedding chúng tôi mới thấy vướng. Hãy đo trước.",
    ar: "رأي غير شائع: معظم الفرق لا تحتاج قاعدة بيانات متجهات من اليوم الأول. حملنا Postgres مع pgvector حتى 40 مليون متجه قبل أن نشعر بأي ضغط. قِس أولًا.",
  },
  13: { zh: "写了个小小的 eBPF 工具，能把每一次 TCP 重传都归因到具体是哪个 Kubernetes Pod 引起的。「网络好慢」类工单的排查从几天缩短到几分钟。这周开源。" },
  14: {
    en: "A counterintuitive hiring lesson: several of our best engineers had ordinary résumés, but each kept a carefully written GitHub project going for two-plus years that hardly anyone used.",
    ja: "採用で得た直感に反する教訓：最高のエンジニアの何人かは、履歴書はごく普通でした。ただ全員、ほとんど誰も使っていないのに丁寧に書かれた GitHub プロジェクトを 2 年以上メンテしていました。",
    ko: "채용에서 얻은 반직관적인 교훈: 우리 최고의 엔지니어 몇 명은 이력서가 평범했지만, 거의 아무도 쓰지 않는데도 정성껏 작성한 GitHub 프로젝트를 2년 넘게 유지하고 있었습니다.",
    es: "Una lección contraintuitiva de contratación: varios de nuestros mejores ingenieros tenían currículums normales, pero todos mantenían desde hacía más de dos años un proyecto de GitHub muy cuidado que casi nadie usaba.",
    pt: "Uma lição contraintuitiva de contratação: vários dos nossos melhores engenheiros tinham currículos comuns, mas todos mantinham há mais de dois anos um projeto no GitHub muito bem escrito que quase ninguém usava.",
    id: "Pelajaran rekrutmen yang kontraintuitif: beberapa engineer terbaik kami punya CV biasa saja, tapi masing-masing merawat proyek GitHub yang ditulis dengan serius selama lebih dari dua tahun, meski hampir tak ada yang memakainya.",
    vi: "Một bài học tuyển dụng ngược đời: vài kỹ sư giỏi nhất của chúng tôi có CV rất bình thường, nhưng ai cũng duy trì hơn hai năm một dự án GitHub viết rất chỉn chu mà hầu như chẳng ai dùng.",
    ar: "درس غير متوقع في التوظيف: عدد من أفضل مهندسينا كانت سيرهم الذاتية عادية، لكن كلًّا منهم حافظ لأكثر من عامين على مشروع في GitHub مكتوب بعناية رغم أن أحدًا تقريبًا لا يستخدمه.",
  },
};
