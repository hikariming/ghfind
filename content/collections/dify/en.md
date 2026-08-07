Dify.AI is the benchmark project in open-source LLM application development, and its trajectory mirrors the full arc of the global generative-AI industry — from proof of concept to production deployment. Suzhou LangGenius Artificial Intelligence Technology Co., founded in March 2023 by Zhang Luyu, a former member of Tencent's CODING DevOps team, went from a 16-person startup to a GitHub top-100 open-source project with 142,000 stars in barely two years. Its positioning moved through three stages — "RAG-based chatbot development platform," then "visual workflow orchestration tool," then "Agentic workflow executor" — a progression that responded both to the maturing of large-model technology and to enterprise customers graduating from POCs to production AI applications. This report draws on Dify's official documentation, GitHub release logs, founder interviews, and third-party analysis to reconstruct the project's full trajectory, unpack the logic of its architectural evolution, and assess its strategic position and competitive moat in the global LLMOps race.

## The founding team and Zhang Luyu's path

Zhang Luyu's personal history is itself a compressed version of China's internet industry. Born in 1991, he was running his own website by age 12, and after finishing middle school he skipped high school and university entirely to work in the industry directly. In 2009, at 18, he joined the Suzhou game company Snail Games as technical lead of a 20-person team, building infrastructure for the game publishing line — the technical grounding for everything he later did in developer tooling.

In 2018, at 27, Zhang founded Moth (飞蛾), a SaaS product for software-testing collaboration that filled a gap in the DevOps chain. Moth was acquired by CODING, and CODING was itself acquired by Tencent around 2020, which brought Zhang into Tencent for several years. There he managed substantially larger teams — an experience that deepened his read on what Chinese developers need and, more importantly, filled in the commercialization and scaling experience he had been missing.

In 2023, at 32, Zhang left Tencent to start his second company, Dify. Asked about his motivation, he has said in multiple interviews that it came from "dissatisfaction with the status quo" — the job could not draw out his full potential, and that dissatisfaction eventually pushed him toward a path where he controlled his own fate. His arc parallels that of Li Xiang, another founder with only a high-school education who succeeded enormously; both emphasize the same idea: control your own destiny, push the limits of your own growth.

When the team formally started in March 2023, it was only 16 people, but most of the core members were old friends or people Zhang trusted, and the group had the feel of a genuine shared mission. More consequentially, the core founders all came from the former Tencent Cloud CODING DevOps team, with deep experience in SaaS developer tooling — which gave Dify a developer-friendly gene from birth. The team brought accumulated instincts in product design, interaction design, and the Chinese developer market, plus DevOps-side experience in cost control, availability monitoring, and data operations.

During development, Zhang's team ran an unusual "information processing mechanism," sorting market intelligence, technical frontiers, and new-project news into categories — over a thousand items spanning large models, cloud vendors, and software engineering — and used it to drive product decisions. Notably, the team leaned on AI-assisted coding from the earliest stage: GPT-4 handled roughly 40% of the coding work, at least doubling team throughput, with Zhang's own coding efficiency possibly up more than 3×.

## Three stages of technical evolution

Dify's product evolution divides cleanly into three technical phases. Stage one (May 2023 – April 2024) is the chat orchestration tool built around chatbots and RAG. Stage two (April 2024 – February 2025) is the construction of the Workflow orchestration engine. Stage three (February 2025 – present) is the Agentic workflow executor, built around Agent nodes and autonomous reasoning. This was not feature accretion; it was a series of bets on where the LLM application paradigm was going.

**Stage one: the RAG-driven chatbot development platform (May 2023 – April 2024)**

Dify shipped its first formal release and open-sourced it on 11 May 2023, positioned as a RAG-based (retrieval-augmented generation) chatbot development platform. The core idea at this stage was to let developers stand up AI conversational applications quickly: Dify fused Backend as a Service (BaaS) with LLMOps, with built-in prompt orchestration, model management, and dataset operations. The team read LLMOps as "operating large-model applications," with two pillars: making that operation visible, transparent, and explainable so applications improve continuously from live feedback data; and opening it to non-technical people so more of the organization can participate.

Early on, Dify's design showed textbook developer-first thinking. Through a visual interface, developers could build intelligent applications with RAG retrieval without writing complex code — a design idea that opened a new paradigm for LLM app development. Adoption after open-sourcing was immediate: in under a week more than 4,000 applications had been created, and the GitHub star count passed 700 while the repo still had nothing but a README. That growth validated how badly the market wanted low-code LLM application tooling.

**Stage two: building the Workflow orchestration engine (April 2024 – February 2025)**

In April 2024 Dify launched its new flagship product, Dify Workflow — a visual, low-code AI workflow orchestration tool. Its release marked the expansion from single-purpose chatbot scenarios into more complex business-process automation. Unlike a simple chatbot, an AI workflow produces predictable output through multi-step logic, letting developers assemble complex AI applications by dragging nodes (LLM nodes, tool nodes, code nodes, and so on).

Workflow was a direct answer to a shift in demand. Dify co-founder Yan Junchen noted in a late-2024 interview that many enterprises spent 2024 doing PoCs on large-model applications, but that actually exploiting LLM capability across varied scenarios required building more complex workflows. The email-assistant workflow template Dify ships, for instance, uses an LLM to improve phrasing, adjust length, or shift register — well outside the boundaries of simple conversation.

Architecturally, shipping Workflow meant solving a cluster of hard problems: the workflow engine design, persistence of node state, error recovery. Dify runs a microservice architecture on a BaaS foundation, centered on a Flask API service and Celery async task queue, with an integrated workflow engine (node transitions implemented in ReactFlow), permission control (RBAC), and an API gateway. That design supports visual node editing across node types including LLM calls, branching logic, and loops, with runtime state managed by Zustand and support for debug breakpoints and error recovery.

**Stage three: the Agentic workflow executor takes shape (February 2025 – present)**

On 28 February 2025, Dify released v1.0.0 — the watershed in the product's history. The release rebuilt the underlying architecture outright, migrating models and tools that had been coupled into the core codebase out into plugins, producing a layered "core framework + plugin ecosystem" structure. The most radical change was the introduction of Agent strategy plugins, letting developers define agent decision logic through patterns like ReAct and function calling; paired with the newly launched Marketplace, this quickly gathered 120+ official and community plugins.

On 12 March 2025, Dify built on v1.0.0 with the Agent node, giving workflows the capacity for "autonomous reasoning." Unlike preset logic, an Agent node uses the model to call tools on its own; by integrating different agent reasoning strategies, the LLM can select and execute tools dynamically at runtime, which makes tool invocation far more flexible. The decoupling of Agent nodes from Agent strategies has been likened to separating a car's engine from its control system — developers can upgrade the "powertrain" without disturbing the overall architecture.

On 17 July 2026, Dify v1.16.0 shipped, putting Dify Agent into public beta. The release formally introduced Dify Agent with UI-based agent creation, a built-in Linux sandbox, a skill system, and agent management, plus support for using existing agents inside workflows or creating inline ones. v1.16.0 also upgraded intelligent workflow generation, improved the AI workflow generator, and added support for MCP protocol version 2025-06-18 with runtime injection of HTTP headers. These updates mark Dify's formal transition from "workflow orchestration tool" to "Agentic workflow executor."

## Open-source community and GitHub milestones

Dify runs a dual-track strategy — open-source community plus enterprise edition. The open-source version pulls in code and case studies from developers worldwide; the enterprise edition sells paid support and advanced features; the two feed each other. The result has been remarkable growth and community activity.

GitHub star growth has been distinctly non-linear. More than 240 developers joined in on the first day of open-sourcing in May 2023. By the V0.3.13 release on 15 August 2023, the star count had passed 700. Across 2024 stars grew 336%, placing Dify third — behind only Ollama — in the 2024 ROSS Index of the world's fastest-growing open-source startups.

March 2025 brought a major milestone: 80,000 stars, and entry into GitHub's top-100 open-source projects. On 5 June 2025, Dify announced it had passed 100,000 stars on GitHub, formally among the world's top 100 open-source projects. As of May 2026, Dify stood at 142,000 stars — the most popular open-source LLM application development platform on GitHub.

Community vitality shows up in more than stars. Dify has over 700 community contributors and has shipped dozens of releases. Its June 2025 acknowledgements singled out 16 core contributors including @fdb02983rhy, @kurokobo, and @junjiem, for work integrating new LLM capabilities, improving deployment flexibility, developing MCP-proxy plugins, and hardening backend stability. That ecosystem both accelerates Dify's iteration and gives enterprise users a rich supply of plugins and templates, lowering the cost of building and operating on the platform.

Worth noting: Dify's license is the "Dify Open Source License" — Apache 2.0 with an added commercial restriction (no multi-tenant SaaS built on Dify). The design keeps the community free to use the software while preserving room for Dify's own commercialization, a deliberate balance between open source and business.

## Architecture and core capabilities

Dify's architecture is organized around three ideas: modular, extensible, enterprise-grade. It uses a four-layer design that decouples functionality and allows flexible extension, and that structure is what lets Dify carry a project from prototype through production deployment.

**The application interaction layer** is a Next.js/React web frontend providing visual workflow orchestration, prompt editing, and dataset management; developers assemble complex logic chains by dragging nodes. **The service orchestration layer** sits on the BaaS architecture, centered on the Flask API service (RESTful) and the Celery async task queue, with an integrated workflow engine (ReactFlow node transitions), RBAC permission control, and an API gateway. **The model computation layer** exposes a unified model interface supporting 20+ LLM providers (OpenAI, Claude, Llama, and others), managing API keys and fallback strategies behind a standardized interface, and embeds the RAG engine with multi-format document parsing, chunking optimization, and hybrid retrieval (semantic vectors + BM25 keywords). **The data infrastructure layer** stores metadata in PostgreSQL, text embeddings in vector databases such as Weaviate/Qdrant/Milvus, and handles cache and task queues in Redis, with file storage on local disk or cloud services (S3 / Azure Blob).

Dify's technical advantages concentrate in a few areas. On **RAG**, it ships a complete RAG pipeline with hybrid retrieval and reranking, configurable across several vector databases, tuned toward usability and customization. On **model compatibility**, it connects to nearly every mainstream model on the market — OpenAI, Anthropic, Azure OpenAI, Hugging Face, local open-weight models — behind a unified "Model Provider" interface, the broadest multi-model coverage available. On **agents and tool calling**, it wraps a complete agent framework supporting function calling and ReAct strategies and can dispatch 50+ common tools, the most complete implementation in the category.

The 2025 releases strengthened the infrastructure further. v1.6.0 delivered bidirectional support for MCP (Model Context Protocol), so a Dify application can both call external MCP services and be consumed as a standardized service by other systems. v1.9.0 introduced the Knowledge Pipeline and a queue-based graph engine, with multimodal retrieval. v1.10.0 added Triggers for scheduled and webhook invocation — the shift from workflows that respond passively to workflows driven by events.

Implementation-wise, Dify lowers the barrier to LLM application development through **modular layering**, a **microservice core** (API / Worker / Web), **unified data abstraction** (vector-store and storage factories), and **visual orchestration**. Per Dify's own figures, adopting the platform compresses development cycles from a traditional 3–6 months to 2–4 weeks — a 4× improvement — cuts operations cost by 90%, and lifts precision by more than 30% via hybrid retrieval (BM25 + vectors).

## Enterprise expansion and customer cases

Dify's enterprise push began in 2024 with the launch of an enterprise subscription offering private deployment and custom development support; the first customers came from banking, retail, and education. To date Dify has served more than 30 Fortune Global 500 companies, with enterprise features including knowledge-base version management, multi-tenant permission systems, an audit-log module, end-to-end encryption, and data masking.

By sector, Dify's enterprise customers span finance, pharmaceuticals, manufacturing, retail, and consumer electronics. In **finance**, China Merchants Bank used Dify Workflow to combine user profiles, market data, and risk appetite into a compliance-decision-recording agent, lifting wealth-product conversion by 28% and average customer returns by 15%. One large financial institution built a unified knowledge-hub RAG on Dify for cross-business-line retrieval and reasoning, cutting query time from 5 minutes to 1 and cross-department communication cost by 30%.

In **pharma and life sciences**, a multinational drug company paired Dify with Amazon Web Services to build a generative-AI ticket automation solution, integrating the corporate knowledge base, multimodal models, and the ticketing system; ticket handling fell from 10–20 minutes to under 3, saving more than 60 person-days a month. A tertiary hospital in Fujian ran a localized LLM cluster (DeepSeek and others) behind Dify's visual workflows across administrative, research, and clinical scenarios, cutting response time to 15 seconds.

In **manufacturing**, Dify helped a global consumer-electronics giant with 100M+ users build a Voice-of-Customer analysis agent doing sentiment analysis, issue classification, and trend prediction on user feedback, compressing the product iteration cycle from quarterly to monthly. Another manufacturer built a predictive-maintenance agent on Dify, monitoring equipment state in real time from IoT sensor data and warning of failures early, cutting unplanned downtime by 40%.

In **cross-border e-commerce**, a well-known merchant built an AI productivity platform on Dify and had more than 900 applications inside the platform two months after deployment, over 100 of them active, with individual applications hitting hundreds of thousands of calls. One technology company has 7,600 internal applications built on Dify — a clear demonstration of how well the platform serves personalized, small-scope internal needs.

Co-founder Yan Junchen summarizes the three core problems Dify solves for enterprises. First, **systems integration**: Dify is positioned as an open, flexible, easily integrated platform that orchestrates applications through APIs and plugs into existing CRM and ERP systems, compressing what was a 3-month build into 3–4 weeks. Second, **scaling**: 77% of enterprise PoCs never reach scaled deployment for want of performance, maintainability, and extensibility, and Dify leans on the team's DevOps background to support continuous optimization and operations. Third, **the talent gap**: Dify's interface is friendly enough that developers use it to move faster and non-developers can produce a prototype or demo.

## Funding and business model

Dify's funding history tracks the capital market's growing conviction in LLMOps. In July 2023 the company raised an angel round from Delian Capital and China Growth Capital, amount undisclosed; China Growth Capital is a top-tier Chinese early-stage investor focused on new finance, new industry, and new consumption. In 2024, Zhejiang Alibaba Cloud Computing took a stake in Suzhou LangGenius, becoming a shareholder while Dify continued to operate independently.

In August 2024 Dify.AI took strategic investment, further validating the business model. On 10 March 2026, Dify announced a $30M Pre-A round led by Sequoia China, with participation from GL Ventures, Alt-Alpha Capital (a new fund incubated by Bessemer Venture Partners), 5Y Capital, Mizuho Leadinvest, and NYX Ventures. It is the largest raise in the company's history, funding global expansion and R&D.

The business model is a three-layer structure: free open source, cloud subscription, enterprise license. The open-source version can be self-hosted, which suits individual developers and technical teams; Dify Cloud offers SaaS across Sandbox, Professional, and Team tiers; the enterprise edition adds private deployment, SLAs, SSO, and audit logs. The enterprise edition is also listed on AWS Marketplace and Azure Marketplace, reaching enterprise customers through cloud-vendor channels.

A quarter of Dify's overseas revenue now comes through the AWS channel. That owes to Dify joining the AWS startup network in 2023 for cloud resources and, after commercializing in 2024, accumulating customers on AWS Marketplace. Fortune 500 companies hold very high bars on security and data compliance; Dify uses Amazon CDK to deploy quickly into VPC environments and Amazon KMS for encrypted storage, meeting those requirements and thereby entering the vendor-selection shortlist at many large enterprises.

## Competitive landscape and positioning

In the global LLM application development market, Dify competes on several fronts at once. Direct competitors include open-source frameworks like LangChain and LlamaIndex, and low-code/no-code platforms like Coze, FastGPT, RAGFlow, and n8n. Against all of them, Dify's positioning is clearly differentiated.

**Versus LangChain**: LangChain is an open-source framework and developer toolkit for integrating large language models into applications, and leans on flexible configuration at the code level. Dify is better suited to building LLM applications quickly and easily, offering a complete UI solution and seamless integration, with much more attention to developer experience and visual operation. Dify emphasizes model neutrality, letting users work with any model without restriction through the UI and platform integrations — a fit for developers who prefer working through an interface and want integration to feel direct.

**Versus Coze**: Coze is ByteDance's no-code bot/agent builder, a closed-source SaaS aimed mainly at non-technical users and content creators. Dify, by contrast, is an open-source LLM application development platform with broader capability — workflows, RAG, agents, the full stack — and fits teams with engineering capacity. Coze is the fastest to pick up; Dify is the most complete.

**Versus RAGFlow**: RAGFlow specializes in complex document parsing and is outstanding at deep document understanding, especially scans and tables. It is a dedicated RAG engine, but it lacks Dify's prompt IDE and complete agent framework. For complex-document scenarios, a common pattern is to use RAGFlow as the knowledge-base backend and have Dify call its API for the LLM interaction layer.

**Versus n8n**: n8n is a workflow-automation and AI-agent platform under a fair-code license with 400+ integrations, suited to technical teams and operations automation. Dify and n8n are frequently combined in enterprise architectures: n8n handles external system integration (trigger conditions, data sync) and calls Dify's API through an HTTP node, while Dify owns the LLM application logic (RAG, prompt management, agents).

On GitHub stars, as of May 2026 Dify's 142,000 leads RAGFlow's 80,700, making it the hottest open-source project in the category. Dify's core advantage is **full-stack capability**: rather than offering RAG or workflows or agents in isolation, it consolidates them into one platform that manages the entire lifecycle from prototype to production. Its **plugin ecosystem** and **LLMOps capabilities** (monitoring, logging, A/B testing) are the other significant moat separating it from pure code frameworks.

## What comes next, and the industry effect

Dify's roadmap reveals where LLMOps is heading. Per official release notes and founder interviews, the 2026-and-beyond evolution focuses on three directions: **agent autonomy**, **deep multimodal integration**, and **edge computing support**.

On agent autonomy, Dify is building a long-term memory module that will let agents learn continuously across sessions — meaning AI agents acquire something like human long-term memory, accumulating knowledge across many interactions and improving their decisions. The Linux sandbox and Dify Agent (beta) in v1.16.0 mark Dify's entry into a genuine agent runtime with autonomous execution and environment isolation.

On multimodality, the Knowledge Pipeline is adding a video-parsing node with frame-level semantic extraction. v1.12.0, released in January 2026, already introduced multimodal retrieval across image, audio, and video input. Together these move Dify from a text-centric platform toward genuine multimodal AI infrastructure.

At the industry level, Dify's growth advances the idea of democratizing AI applications. Its mission is to make AI application development universally accessible — to let non-technical people build AI applications and push generative AI into every industry. The idea sits in a direct line with cloud computing lowering the barrier to IT infrastructure in the 2010s and low-code platforms lowering the barrier to software development in the 2020s.

Zoomed out further, Dify's rise reflects the global AI industry shifting from model-centric to application-centric. As large-model technology matures, attention is moving from benchmarking foundation-model performance to creating value at the application layer. Dify is the bridge between the model layer and the application layer, and its trajectory suggests LLMOps will become one of the core pieces of AI infrastructure. Much as Docker became the standard tool for application containerization in the cloud era, Dify has a shot at becoming the standard platform for LLM application development.

It faces real challenges, though. First, **balancing commercialization against open source**: sustaining commercial return without draining community vitality is the shared difficulty of every open-source project. Second, **iteration speed**: LLM technology moves fast, and Dify has to keep pace with the newest model capabilities and industry standards such as MCP. Third, **intensifying competition**: as the market for AI application tooling matures, giants like ByteDance and Alibaba Cloud may increase their investment, and Dify has to keep sharpening its differentiation.

## Conclusion

Dify.AI's trajectory since its March 2023 founding is a textbook case of an open-source project finding its position, building a moat, and commercializing inside a fast-changing AI industry. The success factors reduce to four. First, **precise market positioning** — the founding team's deep read on developer needs kept feature design close to real scenarios. Second, **well-executed open-source strategy** — GitHub built an enormous developer community and an ecosystem moat. Third, **architectural foresight** — from a BaaS + LLMOps foundation to a plugin-based, agent-based architecture, Dify has stayed ahead of the technical trend. Fourth, **sustained investment in enterprise capability** — from early developer tool to production AI infrastructure, Dify completed the transition into the enterprise market.

The move from chat orchestration tool to Agentic workflow executor is not only Dify's product evolution; it is a miniature of the paradigm shift in LLM application development overall. The chatbots of 2023 were a first attempt at human-machine dialogue; the workflows of 2024 answered the demand for business-process automation; the agents of 2025–2026 mark the leap from AI that responds to AI that acts. Dify played a pivotal role in that transition, and its technical path offers the industry a valuable reference model.

Looking forward, Dify will keep deepening its cloud-vendor partnerships and optimizing inference performance and cost; it plans more vertical AI solutions, in areas such as intelligent customer service and document processing; and it is accelerating its push into North America and Europe with the goal of becoming a leading international LLMOps platform. As the global generative-AI industry enters its scaled-application phase, Dify is well placed to keep compounding its combined advantages in open-source ecosystem, technical architecture, and enterprise capability, and to become key infrastructure for democratizing AI applications.

For enterprises and developers positioning themselves in LLM application development, Dify's case carries a clear lesson: in a field iterating this fast, the strength of an open-source community, an uncompromising focus on developer experience, and end-to-end capability from prototype to production are what build durable competitive advantage. Dify's history shows that even in an AI race crowded with giants, a startup team that focuses on a specific scenario and keeps iterating still has a path to becoming a world-leading open-source project.

## References

[1. Dify vs Langchain: A comprehensive analysis of AI application development](https://zhuanlan.zhihu.com/p/700599048) -

[2. Dify official site](https://www.dify-china.com/) -

[3. Fast-growing Dify.AI owes it to excellent product technology — and to this partner - DOIT](https://www.doit.com.cn/p/531899.html) -

[4. Dify.AI raises Pre-A round](https://www.iyiou.com/data/202603101123711) -

[5. Dify Raises $30M: Tomorrow's Organizations Will Be Built ...](https://dify.ai/blog/dify-raises-30m-tomorrow-s-organizations-will-be-built-by-people-and-agents) -

[6. China Growth Capital](http://www.chinagrowthcapital.com/Index/tree/id/22) -

[7. Smart-tech investment daily (Aug 28): Dify.AI receives strategic investment](https://www.iyiou.com/data/202408291076155) -

[8. Sequoia leads: open-source platform Dify announces $30M round](https://www.donews.com/news/detail/1/6459747.html) -

[9. Behind opening the Japanese market: how Dify does AI globalization](https://finance.sina.com.cn/tech/roll/2024-12-19/doc-inczwynq0848397.shtml) -

[10. With AWS, Dify went from open source to tens of millions in revenue in two years - DOIT](https://www.doit.com.cn/p/541904.html) -

[11. July 2024: where have the AI middle-layer companies gotten to?](https://tsingtaoai.com/newsinfo/7442817.html) -

[12. Three RAG knowledge bases compared: Dify, ChatWiki and RAGFlow](https://www.sohu.com/a/886098919_121478948) -

[13. Deep dive: Dify, FastGPT and RAGFlow — which is the strongest AI workflow platform?](https://huangf.org/posts/aiworkflow/) -

[14. 100K Stars on GitHub: Thank You to Our Amazing Open ...](https://dify.ai/blog/100k-stars-on-github-thank-you-to-our-amazing-open-source-community) -

[15. Dify.AI open-sourced: what does 700+ GitHub stars tell us?](https://docs.feishu.cn/v/wiki/BSrnwvuPXiLsUkkkuuYc6o3pnGg/ac) -

[16. Two non-linear growth curves for one platform: Dify.AI's rise and generative-AI productivity](https://www.163.com/dy/article/JS5J2QGL05118UGF.html) -

[17. From GitHub breakout to enterprise deployment: Dify.AI and AWS serving the world](https://finance.sina.com.cn/tech/roll/2025-03-31/doc-inerpuqs1118272.shtml) -

[18. AI applications into enterprise systems fast: Dify takes the global market via AWS Marketplace](https://itpromag.com/2025/09/05/dify-aws/) -

[19. Dify founder Zhang Luyu, the person and his thinking about Dify - Tencent Cloud](https://cloud.tencent.com/developer/article/2637419) -

[20. From leaving Tencent to GitHub #51 — Dify: how "someone the big companies didn't want" ...](https://liuwei.blog/2026/03/25/%25E4%25BB%258E%25E8%2585%25BE%25E8%25AE%25AF%25E7%25A6%25BB%25E8%2581%258C%25E5%2588%25B0github%25E7%25AC%25AC51%25E5%2590%258D/) -

[21. Orchestrating large-model applications like Docker: how did this ten-person young startup build an LLMOps platform in 2 months? - InfoQ](https://www.infoq.cn/article/5eme94puajjpeiepzht7) -

[22. Dify founder Zhang Luyu, the person and his thinking about Dify - Tencent Cloud](https://cloud.tencent.com/developer/article/2637419) -

[23. Dify company background and history - CSDN](https://blog.csdn.net/Leon_Jinhai_Sun/article/details/146561818) -

[24. 100K Stars on GitHub: Thank You to Our Amazing Open Source Community - Dify](https://dify.ai/blog/100k-stars-on-github-thank-you-to-our-amazing-open-source-community) -

[25. Dify for enterprise AI agent development: 2026 real-world cases and practical guide - CSDN](https://blog.csdn.net/weixin_48708052/article/details/158768151) -

[26. Docs](https://docs.feishu.cn/v/wiki/RN8qwcu6EiexTPkuOAEcy6USneT/ab) -

[27. Fast-growing Dify.AI owes it to excellent product technology — and to this partner - Dostor](https://www.dostor.com/p/98178.html) -

[28. Analysis of Dify's technical architecture - ModelEngine community](https://modelengine.csdn.net/690b1e4c5511483559e273e2.html) -

[29. Dify vs Coze vs RAGflow vs n8n: how to choose a low-code AI platform? A 2026 deep comparison - SegmentFault](https://segmentfault.com/a/1190000047774699) -

[30. Dify vs Langchain: A comprehensive analysis of AI application development - Zhihu](https://zhuanlan.zhihu.com/p/700599048) -

[31. Dify official site](https://www.dify-china.com/) -

[32. Deep dive: Dify, FastGPT and RAGFlow — which is the strongest AI workflow platform?](https://huangf.org/posts/aiworkflow/) -

[33. Releases · langgenius/dify · GitHub](https://github.com/langgenius/dify/releases) -

[34. Blog - Dify](https://dify.ai/zh/blog) -

[35. Dify's 2025 technical evolution in summary](https://www.53ai.com/news/dify/2025112961328.html) -

[36. Dify Workflow launches - 53AI](https://www.53ai.com/news/dify/1866.html) -

[37. Dify's "Agent node" teaches workflows to reason autonomously - 53AI](https://www.53ai.com/news/dify/2025042360384.html) -

[38. Dify's 2025 technical evolution in summary - 53AI](https://www.53ai.com/news/dify/2025112961328.html) -
