> This is the first issue of our "Editor's Picks" column. We didn't want to put together a perfunctory list; we wanted to seriously engage with one question: when AI is no longer just a chat box that talks, what else can it be? For this issue, we picked three open-source projects that couldn't be more different in style, yet resonate deeply with one another — one that gives AI a "life," one that gives AI "hands," and one that gives AI a scalable "body."

## Editor's note: why these three

In 2026, the word "agent" has gone from buzzword to engineering reality. But when most people talk about agents, they're still asking "can it answer me better?" For this issue we want to flip the angle: **an agent shouldn't be a tool that's only summoned on demand — it should be an entity that persists, keeps operating, and even keeps living.**

Following that thread, we picked three stars that happen to form a three-layer map of the agent, from the inside out:

- **yuiju** (yixiaojiu/yuiju) — lets an AI character eat, attend school, take walks, and keep a diary in a world of her own, living a life that exists independently of the user. This is the agent's 「心」 ("heart").
- **lathe** (initiated by samzong, now maintained under the lathe-cli organization) — turns existing APIs, in one shot, into CLI contracts and Skills that agents can safely call, giving agents 「手」 ("hands") that can operate real systems.
- **mosoo** (langgenius/mosoo) — runs coding agents such as Codex, the Claude Agent SDK, and OpenCode at scale inside Cloudflare-native isolated sandboxes. This is the agent's 「身体」 ("body").

A heart that knows how to live, a pair of hands that can do real work, a body that can actually run — each answers one fundamental question about "the next form of AI." Here is our deep dive.

## 1. yuiju: not an AI assistant, but a "person" with a life of her own

![Avatar of Yuu-chan, the yuiju character](https://pub-f0560cb5ffde4095b7345da9c0f73c28.r2.dev/collections/agents-heart-hands-body/yuiju-avatar.webp "Figure: avatar of Yuu-chan, the yuiju project character, from the repo's packages/source/picture/ directory")

### A one-line recommendation (from the author)

Before we unpack it, let's quote the recommendation the project's author wrote for yuiju himself — we think it captures the soul of the project precisely:

> yuiju is an AI companionship project built around simulating a character's life in a virtual world. By constructing a virtual world that runs continuously, it gives the character her own life trajectory, social relationships, and growth experiences, rather than merely holding conversations that revolve around the user. Drawing on game-design thinking, the project upgrades AI companionship from a "chat tool" into "a world you can experience over the long term," letting users enjoy exploration, nurturing, interaction, and growing together within that companionship.

### What is it actually doing

Mainstream AI companion products are, at their core, "user-centric persona engines": the character is on call around the clock, and every reply is generated on the spot from a fixed persona prompt. yuiju turns that logic completely upside down — **the world exists before the conversation does.**

This is an LLM-driven "autonomous character life simulation" project, blending AI chat with "AI town" thinking. The character perceives time, weather, place, and her own state inside a continuously advancing virtual world; she makes her own decisions and carries out actions, leaving behind a traceable life trajectory, memories, diary entries, and plans. Users can talk to the character through messaging front ends like QQ and Feishu, but chat is only a window through which the user observes and steps into her life; her replies, her recent updates, and the things she shares on her own initiative all come from experiences that **actually happened** to her in the world — not from text improvised on the spot. The project's philosophy states it plainly: don't build an AI assistant, build a "person" with a life of her own.

### Deep dive: what makes her come "alive"

After reading through its technical documentation, we believe the most commendable thing about yuiju isn't the surface-level fact that "the character speaks up on her own," but the remarkably restrained engineering philosophy underneath:

**First, the world engine advances by tick, not by conversation.** The core module `@yuiju/world` maintains two continuously running processes at once: world-state advancement (time, weather, scene availability, resource quantities — ticking at fixed intervals like a game engine) and character-behavior advancement (reading the character's state, the world state, and her history to compute the actions currently available to her). **Neither process depends on user messages** — even if no one talks to the character, the world keeps running and she keeps living. This is where the phrase "a world that runs continuously" lands in actual engineering.

**Second, the LLM only makes "decisions"; it never "mutates state."** This is the cleverest trade-off in the whole system. "Life" is too continuous to be handed over to a large model for free-form improvisation. yuiju breaks complex behavior down into atomic Actions; the LLM only picks among the candidate Actions whose preconditions are met and returns a structured decision (which one, and why). The actual state changes are carried out by the Action execution logic and settled into behavioral records, which later feed memory, the diary, and message replies. In other words, the model is "the one who chooses on the road of life," while the system is "the ledger that records life as fact" — this both keeps the character's behavior from spinning out of control and makes every experience traceable and replayable.

**Third, memory isn't a pile of chat logs; it's layered.** The message context isn't concatenated indefinitely: the system maintains recent raw messages, a rolling summary, and a natural conversation window at the same time, and the conversation window settles into Memory Episodes at appropriate boundaries, updating the character's memory in the process. The character can therefore "remember today" instead of re-introducing herself from scratch every time. The author also admits frankly in his blog that the memory module is still stored as JSON and self-updated by the LLM, and occasionally gets things wrong — that kind of honesty is exactly what's most moving about open-source projects.

**Fourth, game-design thinking permeates everything.** A dynamic weather system keeps daily life from being a fixed script; the character can hold long-term and short-term plans rather than passively responding to whatever the user just typed; and when something worth telling happens in her life, she shares it at the right moment instead of forever waiting for you to speak first. The author himself describes the project as "an AI character system with state, actions, memory, and a rhythm of life" — the most concise definition of "virtual life" we've seen.

![yuiju system architecture](https://pub-f0560cb5ffde4095b7345da9c0f73c28.r2.dev/collections/agents-heart-hands-body/yuiju-architecture.png "Figure: yuiju system architecture — the @yuiju/world engine advances world state and character behavior in parallel, while the LLM only makes Action decisions")

### Editor's take

yuiju answers a question many AI companion projects dodge: **can an AI have a life of its own when you're not around?** It upgrades companionship from "you summon me" to "we each live our own lives and meet occasionally," grounding the emotional connection in genuinely shared experience rather than sweet talk generated on the fly. The project is still early, and pieces like the memory module are still being polished, but the direction it offers — using a game-engine-style deterministic framework to constrain and carry the LLM's freedom — is enormously valuable reference material for the entire AI-character field. If you love Animal Crossing, or love the feeling of nurturing and companionship, it's worth heading straight to its web page and experiencing it once (`yuiju-web.yixiaojiu.top`). To close, here's a Yuu-chan sticker, so you can get a feel for her little temper:

![Yuu-chan sticker: hmph](https://pub-f0560cb5ffde4095b7345da9c0f73c28.r2.dev/collections/agents-heart-hands-body/yuiju-hmph.png "Yuu-chan sticker: hmph")

## 2. lathe: growing an agent's 「hands」 from your APIs in one shot

![lathe logo](https://pub-f0560cb5ffde4095b7345da9c0f73c28.r2.dev/collections/agents-heart-hands-body/lathe-logo.png "Figure: the lathe project logo, from the repo's docs/images/ directory")

### What it is

lathe is an API-to-CLI generator built for agents: from Swagger 2.0, OpenAPI 3, protobuf with `google.api.http` annotations, or even a GraphQL schema, it generates a **single-binary, production-grade** Cobra CLI, complete with a structured command catalog and a generated Skill guide. The project was initiated by samzong, is now maintained under the lathe-cli organization, is MIT-licensed, and is still young — but iterating extremely fast.

The author's motivation is plain, and rather touching — "plug the old world's existing systems directly into agents." Most teams don't lack APIs; they have piles of legacy APIs and no safe, reliable way to let AI operate them.

### Core philosophy: the spec is the truth, the catalog is the contract

lathe's entire design condenses into two sentences:

1. **The API specification is the single source of truth.** You declare the pinned upstream spec (fixed by tag, resolved to a commit SHA, floating branches rejected), declare the CLI identity (`cli.yaml`) and module sources (`specs/sources.yaml`), and add overlays when needed to polish help text; when the API changes, just regenerate. Gone is the fate of "hand-write a CLI, then spend the rest of your life fighting drift."
2. **The generated CLI isn't just a shell — it's a contract that agents can consume mechanically.** That's the essential difference between lathe and an ordinary API-wrapping tool.

### Deep dive: a complete protocol designed so agents "never have to guess"

Read its README and you'll find that lathe has decomposed "how an agent safely uses a CLI" with unusual care:

- **Discovery**: `search "<intent>" --json` finds candidate commands by natural-language intent; `commands --json` outputs the full command catalog; `commands show <path>` shows a given command's flags, body, auth, HTTP method, and output hints — all as structured JSON.
- **Preflight**: `auth status --hostname <host>` confirms credentials before calling a protected command; `--dry-run` prints the request that would be sent (with redacted headers and body) without actually sending it, letting the agent verify everything before execution.
- **Execution**: `--file` / `--set` / `--set-str` construct request bodies, `-o table|json|yaml|raw` provides machine-readable output, and enum validation, pagination, and streaming are all covered.
- **Generated Skill**: codegen writes out a `skills/<cli-name>/` directory by default — effectively an "agent operator's manual for this CLI" (how to discover commands, inspect the catalog, preflight auth, construct bodies, pick output formats) — and it can even be packed into the binary (`<cli> skill install`). The runtime catalog remains the source of truth; the Skill is the onboarding guide that teaches the agent how to use it.

Three engineering details are also worth mentioning: all generated modules share **the same runtime** (auth, request construction, output, pagination, streaming, and error handling behave consistently); the **overlay layer** lets you hide/ignore commands, fix parameters, and add shortcut commands without touching the upstream spec or the generated Go code; and the two-stage pipeline (`specsync` fetches and pins the spec → `codegen` normalizes it into a unified IR and renders) guarantees reproducibility.

![lathe architecture diagram](https://pub-f0560cb5ffde4095b7345da9c0f73c28.r2.dev/collections/agents-heart-hands-body/lathe-architecture.png "Figure: the lathe generation flow — spec pinned and synced → codegen normalizes and renders → CLI plus companion Skill generated")

### Why now: the CLI is becoming the de facto interface for agents

lathe is riding a very interesting industry wave. Vercel's CEO has said outright that "CLIs are the de-facto MCPs for agents," Perplexity's CTO and Y Combinator president Garry Tan have publicly backed the CLI route around the same time, and the Chinese community at one point went as far as chanting "MCP is dead." Meanwhile, vendors like Feishu maintain both a CLI and an MCP Server as open-source projects at the same time. At this crossroads of the "agent interface wars," lathe's choice is smart: **it doesn't argue over whether CLI or MCP wins — it turns "generate an agent-friendly CLI from an API" itself into an automated pipeline, and generates the companion Skill along with it.**

### Editor's take

lathe suits two kinds of people. The first is teams sitting on a pile of Swagger/OpenAPI/proto/GraphQL who want to plug their existing systems into agents — it's one of the tools that pushes the cost of "connecting the old world to the new" closest to zero. The second is developers who appreciate the engineering aesthetic of "one binary that humans can use and agents can safety-check." It turns "agents shouldn't have to guess" from a slogan into an executable six-step loop (search → inspect → preflight auth → dry-run → execute → structured output), and that is its most solid contribution.

## 3. mosoo: giving coding agents a scalable 「body」 to run in

![mosoo banner](https://pub-f0560cb5ffde4095b7345da9c0f73c28.r2.dev/collections/agents-heart-hands-body/mosoo-banner.png "Figure: the official mosoo banner (2400×1260), from the repo's docs/assets/ directory")

### What it is

mosoo is an open-source, Cloudflare-native **coding-agent runtime**: it runs coding agents such as OpenAI Codex, the Claude Agent SDK, and OpenCode inside mutually isolated AI-agent sandboxes behind an API endpoint, and provides execution records that can be inspected, replayed, and resumed. It comes from **LangGenius (the team behind Dify)** — the open-source LLM application platform — which determined its engineering orientation from day one: not a toy for hobbyists, but infrastructure for developers who want to integrate agents into their own products. Apache 2.0 licensed.

### Which layer of pain it solves

If you want to use coding agents in your own product, you usually hit the same wall: you have to maintain the agent runtime, the sandbox service, session storage, file pipelines, and the Agent API yourself — and every time you onboard a new agent harness (Codex, Claude, OpenCode...), you do it all over again. mosoo's positioning is to fold that whole block into a single **control plane**: your application belongs to you and owns the product behavior and the end-user experience; mosoo only handles agent execution and lifecycle. It positions itself with restraint — "app deployment is another Alpha surface, not part of the core product contract."

### Deep dive: the agent goes from "one call" to "a persistent execution line"

mosoo's five core capabilities map one-to-one onto every link needed to "productize an agent":

- **Unified runtime and control plane**: three agent harnesses are normalized under the same runtime protocol, so you don't have to write three separate integrations for three tools.
- **Agent API**: from a trusted backend, start / follow / continue / stop / archive / delete an agent's work — the agent's work becomes something you can orchestrate.
- **Isolated AI-agent sandboxes**: stream back responses and tool activity, handle permission requests, cancel work, and inspect diagnostics inside an isolated execution environment — making "handing an agent to your users" safe and controllable.
- **Durable work**: threads, runs, events, and managed files persist across multiple executions. This is its most essential idea: an agent isn't a one-shot call, but an execution line that can resume from where it stopped.
- **Observability**: run status, replayable activity, diagnostics, usage estimates — operational visibility, not compliance auditing.

The surrounding ecosystem already has its skeleton in place: `mosoo-agent-driver`, `mosoo-connector`, and an interesting `mosoo-skills` package (20 project-aware coding-agent skills, of which 16 are unmodified copies of public upstreams and 4 are maintained by mosoo and deliberately excluded from the sync manifest, so an upstream refresh can't wipe out project-specific guardrails). On the tech-stack side, it runs natively on Cloudflare Workers + D1 + R2, and can be self-hosted in your own account.

### Risk warning (an honest note from the editors)

Readers should be aware: **mosoo is currently in Alpha.** The official README states clearly that the hosted runtime and Agent API have been released and are covered by repo tests, but "production reliability and external adoption have not yet been validated," and the public API and product behavior may still change. It's therefore a good fit for developers willing to be early adopters and prototype agent productization; if you're planning to stake your production core path on it, be sure to evaluate the risks and isolate it properly first.

### Editor's take

mosoo's significance lies in turning "running coding agents" from a loose DIY assembly job into a deployable, observable, orchestrable piece of infrastructure. While the whole industry is debating "how to turn agents into products," the Dify team has drawn on its accumulated experience with LLM application platforms to offer a Cloudflare-native reference answer — isolated sandboxes, durable sessions, a unified API, resumable execution. For teams extending Codex / the Claude Agent SDK / OpenCode into their own products, it deserves a serious spot on the evaluation shortlist.

## Summary: this issue at a glance

| Project | What it gives the agent | Core philosophy | License/status | Who it's for |
| --- | --- | --- | --- | --- |
| **yuiju** | A 「heart」 that knows how to live — life trajectory, memory, plans | The world precedes the conversation; the LLM decides, the system keeps the ledger | Open source, early and growing | AI-companionship fans, product people and developers researching virtual life |
| **lathe** | A pair of 「hands」 that can do real work — safely callable CLI contracts | The spec is the truth, the catalog is the contract | MIT, relatively mature | Teams with existing APIs to connect to agents, CLI and agent-tooling enthusiasts |
| **mosoo** | A scalable 「body」 — sandboxes, API, durable execution | The agent goes from a call to a persistent execution line | Apache 2.0, Alpha | Developers turning coding agents into products |

## Closing thoughts

For this first issue, we put three seemingly unrelated stars on the same page to say one thing: **the next form of AI is probably not a smarter chat box, but an "entity" that can run, can work, and can live.** yuiju gave it a life, lathe gave it hands, mosoo gave it a body — they represent the three layers of experience, interface, and infrastructure, and the real product of the future will probably need all three at once.

If you happen to be working on something similar, or have a deeper understanding of one of these projects, you're welcome to leave a comment and talk with us. Next issue, we'll dig into the theme of "agent memory" and unearth more open-source projects that deserve to be seen.

**Quick-start and experience links**

- yuiju: repo `github.com/yixiaojiu/yuiju`｜try it online `yuiju-web.yixiaojiu.top`｜author's blog `note.yixiaojiu.top/blog/yuiju`
- lathe: repo `github.com/lathe-cli/lathe` (initiated by samzong)
- mosoo: repo `github.com/langgenius/mosoo`｜cloud experience `cloud.mosoo.ai`｜official site `mosoo.ai`

**Authors and teams**

| Project | Author / team | GitHub |
| --- | --- | --- |
| yuiju | yixiaojiu (Yixiaojiu) | `github.com/yixiaojiu` |
| lathe | samzong | `github.com/samzong` |
| mosoo | LangGenius (the team behind Dify) | `github.com/langgenius` |
