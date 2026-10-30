import type { XCategory } from "@/lib/stream/x";

/**
 * Editorial allowlist for the /feed X timeline (see src/lib/stream/x.ts).
 * Adding or removing a voice is a reviewed code change on purpose.
 *
 * Developers do not need to be listed: an account whose linked GitHub login
 * scores >= X_MIN_DEV_SCORE on ghfind is admitted automatically. List them
 * here only to pin a category or note.
 *
 * Starter set: well-known researchers, builders and tech media, proposed for
 * owner review. `github` is set only where the login is certain.
 */
export type EditorialXAccount = {
  handle: string;
  category: XCategory;
  github?: string;
  talentId?: string;
  /** One line on why this voice is worth a technical reader's time. */
  note: { zh: string; en: string };
};

export const EDITORIAL_X_ACCOUNTS: EditorialXAccount[] = [
  // Researchers
  { handle: "karpathy", category: "researcher", github: "karpathy", note: { zh: "前 Tesla AI / OpenAI，LLM 教学与实践", en: "Ex-Tesla AI / OpenAI; teaches LLMs from scratch" } },
  { handle: "ylecun", category: "researcher", note: { zh: "图灵奖得主，Meta 首席 AI 科学家", en: "Turing Award laureate, Meta chief AI scientist" } },
  { handle: "AndrewYNg", category: "researcher", note: { zh: "DeepLearning.AI 创始人", en: "Founder of DeepLearning.AI" } },
  { handle: "JeffDean", category: "researcher", note: { zh: "Google 首席科学家", en: "Google chief scientist" } },
  { handle: "demishassabis", category: "researcher", note: { zh: "Google DeepMind CEO", en: "Google DeepMind CEO" } },
  { handle: "hardmaru", category: "researcher", note: { zh: "Sakana AI 联合创始人", en: "Sakana AI co-founder" } },
  { handle: "drfeifei", category: "researcher", note: { zh: "斯坦福 HAI，World Labs 创始人", en: "Stanford HAI, World Labs founder" } },

  // Builders / CEOs
  { handle: "gdb", category: "builder", github: "gdb", note: { zh: "OpenAI 联合创始人", en: "OpenAI co-founder" } },
  { handle: "sama", category: "builder", note: { zh: "OpenAI CEO", en: "OpenAI CEO" } },
  { handle: "natfriedman", category: "builder", github: "nat", note: { zh: "前 GitHub CEO，投资人", en: "Former GitHub CEO, investor" } },
  { handle: "rauchg", category: "builder", github: "rauchg", note: { zh: "Vercel CEO，Next.js", en: "Vercel CEO, Next.js" } },
  { handle: "mitchellh", category: "builder", github: "mitchellh", note: { zh: "HashiCorp 联合创始人，Ghostty 作者", en: "HashiCorp co-founder, author of Ghostty" } },
  { handle: "dhh", category: "builder", github: "dhh", note: { zh: "Ruby on Rails 作者", en: "Creator of Ruby on Rails" } },
  { handle: "simonw", category: "builder", github: "simonw", note: { zh: "Datasette 作者，LLM 工具实践记录", en: "Datasette creator, hands-on LLM tooling notes" } },
  { handle: "swyx", category: "builder", github: "sw-yx", note: { zh: "Latent Space，AI 工程", en: "Latent Space, AI engineering" } },
  { handle: "amasad", category: "builder", github: "amasad", note: { zh: "Replit CEO", en: "Replit CEO" } },
  { handle: "ID_AA_Carmack", category: "builder", note: { zh: "id Software 联合创始人，Keen Technologies", en: "id Software co-founder, Keen Technologies" } },
  { handle: "patrickc", category: "builder", note: { zh: "Stripe CEO", en: "Stripe CEO" } },

  // Tech media
  { handle: "GergelyOrosz", category: "media", note: { zh: "The Pragmatic Engineer", en: "The Pragmatic Engineer" } },
  { handle: "theinformation", category: "media", note: { zh: "科技深度报道", en: "In-depth tech reporting" } },
  { handle: "TechCrunch", category: "media", note: { zh: "创业与科技新闻", en: "Startup and tech news" } },
  { handle: "arstechnica", category: "media", note: { zh: "技术新闻与评测", en: "Technology news and analysis" } },
  { handle: "_akhaliq", category: "media", note: { zh: "每日 AI 论文速递", en: "Daily AI paper digest" } },
];
