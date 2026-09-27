大型语言模型（LLM）推理框架的竞争格局正在经历深刻变革，而SGLang作为这一领域最具创新力的开源项目之一，已经从学术研究走向商业化运营。本报告将系统梳理SGLang项目的发展历程、核心技术架构、创始团队背景以及商业化路径，为开发者社区提供全面而深入的项目洞察。

## SGLang创始人盛颖：从ACM竞赛到AI基础设施前沿

盛颖（Ying Sheng）作为SGLang项目的主要发起人和商业化推动者，其个人经历本身就是一段从学术到产业、从开源到商业的精彩旅程。根据公开资料，盛颖本科毕业于上海交通大学计算机科学与技术专业ACM荣誉班，随后在哥伦比亚大学取得计算机科学硕士学位，并在斯坦福大学计算机科学系获得博士学位，师从Clark Barrett教授，研究方向涵盖形式化验证、机器学习系统以及大型语言模型。这种横跨算法、形式化方法和AI系统的学术训练，为她后来主导SGLang项目的技术路线奠定了坚实基础。

在学术生涯之外，盛颖拥有丰富的工业界实践经验。她曾在Two Sigma担任量化软件工程师，在Facebook Novi从事智能合约验证相关的研究实习，并在X（前Google登月工厂）担任Ph.D.驻场研究员开展AI for Code相关工作。这些经历使她深刻理解从学术研究到工业落地之间的鸿沟，也为她后来在AI基础设施领域的创新提供了跨学科视角。值得注意的是，她在UC Berkeley Sky实验室担任访问研究员期间，与Ion Stoica和Joseph E. Gonzalez等系统领域知名学者合作，这段经历直接催生了她对高效LLM推理系统的研究兴趣。

2024年10月至2025年8月期间，盛颖加入xAI并共同领导推理团队，这段在埃隆·马斯克旗下AI公司的实战经验让她深入接触到大规模AI模型推理的工业级挑战。然而，她最终选择离开xAI，于2025年中期创立RadixArk公司，将SGLang项目商业化，这一决策体现了她对开源AI基础设施价值的深刻信念。据公开报道，盛颖在多个场合强调AI基础设施应该追求美感与精益求精，这种理念贯穿了SGLang的技术设计和社区运营。她的职业轨迹——从ACM竞赛选手到斯坦福博士，再到xAI技术负责人，最终成为RadixArk的CEO——展现了一位技术领导者如何将学术理想与商业现实相结合的典范。

## LMSYS组织：开源AI生态的孵化器

SGLang项目并非孤立发展，而是深深植根于LMSYS（Large Model Systems Organization）这一独特的开源生态系统之中。LMSYS起源于2023年加州大学伯克利分校、斯坦福大学、加州大学圣地亚哥分校、卡内基梅隆大学以及穆罕默德·本·扎耶德伊斯兰大学之间的多校合作项目，并于2024年9月正式注册为501(c)(3)非营利组织。这种学术背景赋予了LMSYS在AI研究领域的独特公信力，使其成为连接学术前沿与工业实践的重要桥梁。

LMSYS的使命是通过共同开发开源模型、数据集、系统和评估工具，让所有人都能使用大型人工智能模型。该组织已经孵化出多个具有广泛影响力的项目，其中FastChat拥有约3.95万GitHub星标，Vicuna模型曾在开源社区引发巨大关注，Chatbot Arena（现LMArena）则成为全球最具影响力的众包LLM评测平台。SGLang作为LMSYS的旗舰项目之一，当前在GitHub上已获得超过3.63万星标，每天为全球超过40万块GPU提供推理服务支持。这种组织生态为SGLang提供了技术验证、人才储备和社区推广的全方位支持。

在治理结构上，LMSYS采用了独特的学术与产业混合模式。组织顾问名单包括UC Berkeley的Joseph E. Gonzalez和Ion Stoica、Carnegie Mellon University的Eric P. Xing等知名学者，同时吸引了来自NVIDIA、AMD、Google Cloud、a16z等机构的赞助支持。这种架构确保了LMSYS项目既能保持学术严谨性，又能获得产业界的资源支持。对于SGLang而言，LMSYS不仅提供了法律和财务上的托管，更重要的是赋予了项目中立性和公信力，使其能够吸引来自竞争对手（如NVIDIA和AMD）的共同投资和支持。

## SGLang技术演进：从学术论文到生产级系统

SGLang的技术发展历程可以清晰地划分为学术原型、开源迭代和商业化加速三个阶段，每个阶段都标志着项目在技术深度和应用广度上的重大跨越。项目最初源于Lianmin Zheng、Liangsheng Yin、Zhiqiang Xie等研究人员在2023年12月12日发表于arXiv的论文《SGLang: Efficient Execution of Structured Language Model Programs》。这篇论文首次提出了结构化生成语言的概念，旨在解决当时LLM编程中缺乏高效执行系统的痛点。随后在NeurIPS 2024会议上，该论文被正式接收，标志着学术界对SGLang技术路线的高度认可。

2024年1月17日，LMSYS团队通过官方博客正式对外发布了SGLang项目，同时开源了代码实现。这一版本的SGLang已经展现出前后端协同设计的核心理念：后端通过RadixAttention实现KV缓存的自动复用，前端提供嵌入Python的领域特定语言（DSL）用于控制生成过程。项目初期的性能测试显示，在NVIDIA A10G GPU上使用Llama-7B和Mixtral-8x7B模型时，SGLang的吞吐量比当时的先进系统（Guidance和vLLM）高出最多5倍，特别是在首token延迟方面，前缀缓存命中带来了显著收益。

进入2024年，SGLang经历了快速的版本迭代。v0.2版本增加了对Llama3服务的支持，v0.3版本引入了DeepSeek MLA优化，到v0.4版本时，项目已经实现了零开销调度器、Cache-Aware Router、数据并行注意力（DPA）和XGrammar结构化生成等关键特性。这一阶段的SGLang逐渐从研究原型转变为可生产部署的推理引擎，开始支持更广泛的模型和硬件平台。

2025年是SGLang技术成熟的关键一年。v0.5版本的发布标志着项目在结构化生成、多模态支持和硬件适配方面达到了新高度。该版本不仅扩展了对视觉语言模型（VLM）的支持，还通过xGrammar实现了更高效的结构化输出生成。与此同时，SGLang开始支持DeepSeek系列模型的部署，并成为首个完全开源的DeepSeek大规模专家并行部署方案。这些技术进步为SGLang在2026年的爆发式增长奠定了技术基础。

截至2026年9月，SGLang已经迭代至v0.5.20版本，该版本累计合并了来自237位贡献者的713个PR。新版本引入了GLM-5.3-Flash、Qwen3.8-Flash-Next、K2 Horizon等多款前沿模型支持，并实现了统一基数树优化、解码上下文并行、SGLang模拟器等创新功能。特别值得注意的是，统一基数树优化将DeepSeek-V4-Flash的token命中率从43.8%提升至60.8%，平均首token延迟从1.57秒降至1.07秒，展现了项目在技术优化上的持续投入。

## SGLang核心技术架构：前后端协同设计

SGLang的技术架构体现了"前后端协同设计"的核心理念，这一设计哲学使其区别于传统的推理框架。具体而言，SGLang由前端结构化生成语言和后端高性能运行时两部分组成，二者通过紧密协作实现对复杂LLM程序的高效执行。这种架构设计的根本出发点是认识到现代AI应用已经不再满足于简单的单次模型调用，而是需要多轮对话、工具调用、结构化输出等复杂的程序化交互模式。

在后端核心技术方面，**RadixAttention**无疑是SGLang最具创新性的贡献。该技术基于基数树（Radix Tree）数据结构实现KV缓存的自动复用，解决了多轮对话、少样本学习、思维树等场景中存在的重复计算问题。与传统系统在请求完成后丢弃KV缓存的做法不同，RadixAttention将提示和生成结果的KV缓存保留在基数树中，通过高效的前缀搜索、插入和驱逐机制，实现跨请求的缓存共享。系统还实现了最近最少使用（LRU）驱逐策略和缓存感知调度算法，当等待队列中有多个请求时，优先处理具有较长匹配前缀的请求，从而最大化缓存命中率。实验表明，在典型的多轮对话场景中，RadixAttention可以将缓存命中率提升3-5倍，显著降低响应延迟。

SGLang的后端还包含多项性能优化技术。**零开销调度器**通过CPU/GPU重叠执行机制，在GPU执行当前批次的同时异步准备下一批次，实现了95%以上的GPU利用率。这一设计解决了传统推理系统中CPU调度成为瓶颈、GPU空闲等待的问题。**连续批处理**（Continuous Batching）允许系统在运行时动态调整批次大小，将新到达的请求与正在处理的请求合并执行，从而最大化吞吐量。此外，SGLang还支持分页注意力、张量并行、流水线并行、专家并行等多种并行策略，以及FP4/FP8/INT4等多种量化方案，使其能够适应从单卡到大规模分布式集群的各种部署场景。

在前端设计方面，SGLang提供了一种嵌入Python的领域特定语言（DSL），使开发者能够以声明式的方式编写复杂的LLM程序。该DSL提供了gen、select、fork、image等原语，支持控制流、并行性、多模态输入和约束解码等高级功能。例如，开发者可以使用fork原语创建多个并行提示副本，利用gen原语进行非阻塞生成调用，或者通过regex参数实现正则表达式约束的结构化输出。这种前端语言的设计目标是替代传统的LangChain等编排框架，通过解释执行或图执行的方式实现更高的执行效率。

值得关注的是，SGLang的结构化生成能力在业界处于领先地位。通过压缩有限状态机（FSM）和xGrammar语法引擎，SGLang能够确保生成文本严格符合JSON Schema、正则表达式或上下文无关文法定义的约束，无需后处理或重试。这一能力对于需要精确输出格式的企业应用（如API响应生成、数据库查询构建）具有重要价值。在SGLang v0.5.20版本中，项目还引入了采样掩码捕获和重叠调度功能，在Qwen3-8B模型上实现了17%（batch=1）到52%（batch=64）的解码吞吐量提升。
## 商业化路径：RadixArk的成立与AI推理市场格局

SGLang项目的商业化进程在2025年至2026年间显著加速，最终催生了RadixArk公司的成立，这一事件标志着开源AI基础设施项目探索商业模式的重要里程碑。2025年7月至8月期间，盛颖与团队核心成员开始讨论是否离开各自的工作环境，全职投入SGLang生态的建设。经过深思熟虑，团队决定以SGLang为基础创立商业公司RadixArk，由盛颖担任CEO，联合创始人包括来自NVIDIA背景的Banghua Zhu担任CTO。

2026年1月，TechCrunch等权威科技媒体首次报道了RadixArk的融资消息，称SGLang项目将分拆为独立公司，估值约4亿美元。随后在2026年5月5日，RadixArk正式宣布完成1亿美元种子轮融资，投后估值达到4亿美元，由Accel领投，Spark Capital联合领投。这一融资事件在2026年的AI基础设施赛道中堪称最重磅的早期投资之一，不仅因为其金额和估值规模，更因为其投资人阵容的豪华程度。

RadixArk的投资方名单几乎囊括了AI产业链的所有关键参与者。除了领投方Accel和Spark Capital外，还包括NVIDIA的风险投资部门NVentures、AMD、MediaTek等芯片巨头，以及Salience Capital、A&E Investments、HOF Capital、Walden International等知名投资机构。特别值得关注的是，NVIDIA和AMD这两家通常处于竞争关系的芯片公司罕见地共同投资了一家初创企业，这充分说明了RadixArk技术的战略价值。据华尔街日报报道，Broadcom首席执行官Hock Tan也参与了本轮投资。这种跨产业链的投资格局表明，业界普遍认为RadixArk在AI推理优化领域的技术路线具有变革性潜力。

从商业模式来看，RadixArk计划围绕SGLang开展商业化服务，同时持续推进其开源开发。据公开报道，公司的业务将从推理扩展到模型训练领域，旨在为前沿AI模型提供开放的基础设施。值得注意的是，尽管RadixArk已经商业化，SGLang项目仍然托管在非营利组织LMSYS旗下，保持了开源的独立性。这种"开源核心+商业服务"的模式与Linux Foundation、MongoDB等成功开源项目的商业路径相似，既保证了技术的开放性和社区活力，又为企业客户提供了专业的技术支持和服务保障。

## 生态建设与行业应用：从实验室到40万GPU

SGLang的技术价值最终体现在其广泛的行业应用和庞大的部署规模上。根据官方文档，截至2026年，SGLang已经在全球范围内超过40万块GPU上运行，每天为生产环境处理数万亿个token。这一部署规模使SGLang成为当前AI推理领域事实上的标准之一，与vLLM、TensorRT-LLM等框架共同构成了大模型部署的基础设施层。

SGLang的行业应用覆盖了从云服务提供商到终端用户的完整产业链。在云服务领域，AWS、Google Cloud、Microsoft Azure、Oracle Cloud等主流云平台均支持SGLang部署。在硬件厂商方面，NVIDIA、AMD、Intel不仅投资RadixArk，还在各自的产品线和文档中积极推广SGLang。在中国科技企业中，百度、阿里巴巴、腾讯、蚂蚁集团等头部公司也在生产环境中采用SGLang进行大模型推理。此外，Cursor、LinkedIn、xAI等创新型公司同样信赖SGLang的性能和稳定性。

SGLang特别适合处理需要复杂交互模式的AI应用场景。在多轮对话系统中，RadixAttention的前缀缓存机制能够显著降低延迟，提升用户体验。在AI Agent工作流中，SGLang的DSL语言使开发者能够轻松表达工具调用、并行推理和状态管理等复杂逻辑。在结构化输出场景（如JSON生成、API响应格式化）中，SGLang的约束解码能力确保了输出的合法性和一致性，避免了传统方法中常见的格式错误问题。这些特性使SGLang成为构建下一代AI应用的首选推理引擎之一。

在模型支持方面，SGLang展现出极强的生态系统兼容性。项目支持Llama、Qwen、DeepSeek、Kimi、GLM、GPT、Gemma、Mistral等主流语言模型，以及e5-mistral、gte等嵌入模型和Skywork等奖励模型。在视觉和音频领域，SGLang支持LLaVA、Qwen-VL等多模态模型，以及WAN、Qwen-Image等扩散模型。特别值得关注的是，SGLang对前沿模型的支持速度极快，通常在模型发布的当日或数日内即可提供完整的推理支持。例如，2026年7月，SGLang与Miles框架共同为Kimi K3模型提供了首日支持；2026年9月，项目又为DeepSeek-V4.1提供了快速集成。

硬件适配的广泛性也是SGLang生态建设的重要一环。项目不仅支持NVIDIA的全系列GPU（从消费级的RTX 5090到数据中心的GB200/B300/H100），还支持AMD MI355/MI300系列、Intel Xeon CPU、Google TPU、华为昇腾NPU以及摩尔线程MUSA等国产硬件平台。这种跨平台能力使SGLang能够适应不同用户的硬件环境和成本约束，特别是在当前AI芯片多元化的趋势下具有重要战略意义。

## SGLang与vLLM：技术路线的竞合关系

在开源LLM推理框架领域，SGLang与vLLM是最具代表性的两个项目，二者既有竞争关系，又在技术演进中相互借鉴、共同推动行业发展。理解二者的差异和各自优势，有助于开发者根据具体应用场景做出合理的技术选型。

从设计理念来看，vLLM由UC Berkeley的Sky Computing Lab开发，核心创新是PagedAttention技术，借鉴操作系统的分页机制将KV缓存划分为固定大小的块，实现动态内存分配，从而将内存效率提升3-4倍，支持更高的并发量。相比之下，SGLang的设计更加强调前后端协同，不仅关注单次推理的效率，更致力于优化复杂LLM程序（涉及多次模型调用、控制流和结构化输出）的整体执行效率。这种设计目标的差异决定了二者在不同场景下的性能表现。

在性能基准测试方面，多个独立测试显示SGLang在多轮对话和结构化输出场景中具有显著优势。根据阿里云2025年6月的测试数据，在单卡部署Qwen系列模型时，SGLang的首字延迟（TTFT）比vLLM优约18%，每token输出延迟（TPOT）优10%至15%。在更复杂的工作负载中，SGLang的优势进一步扩大。例如，在涉及多轮对话和少样本学习的场景中，SGLang的吞吐量比vLLM高出最多5倍，这主要归功于RadixAttention的前缀缓存机制。然而，在高并发的单轮推理场景中，vLLM凭借其成熟的内存管理和调度机制，通常展现出更稳定的性能表现。

从技术生态来看，vLLM拥有更大的社区规模和更广泛的模型支持。vLLM的GitHub星标数超过SGLang，且其API设计更加贴近Hugging Face生态，对于希望快速迁移现有项目的开发者而言门槛较低。相比之下，SGLang的学习曲线较陡，开发者需要掌握其DSL语言才能充分利用框架的高级特性。不过，SGLang在结构化生成、多模态处理和分布式缓存等前沿领域的技术深度，使其在构建复杂AI应用时具有不可替代的优势。

值得注意的是，两个项目之间并非纯粹的竞争关系。SGLang的GitHub页面明确致谢了vLLM、Guidance、LightLLM、FlashInfer等项目的设计和代码复用，而vLLM在2024年也引入了Automatic Prefix Caching功能，这在技术上与SGLang的RadixAttention有异曲同工之妙。这种相互借鉴推动了整个开源推理框架生态的技术进步。2026年初，vLLM核心团队同样选择成立商业公司Inferact，完成1.5亿美元融资，估值达8亿美元。SGLang和vLLM相继走向商业化，标志着开源大模型推理引擎已经从技术探索阶段进入产业落地阶段，AI推理市场正在走向系统化与专业化治理。

## 结论与展望

SGLang项目的发展历程为开源AI基础设施的演进提供了极具价值的案例研究。从技术角度看，SGLang通过前后端协同设计、RadixAttention等核心创新，成功解决了复杂LLM程序执行中的效率瓶颈，在结构化生成、多轮对话等场景中展现出显著的技术优势。从生态角度看，SGLang依托LMSYS组织的学术背景和中立性，构建了跨越产学研的广泛合作网络，获得了从NVIDIA、AMD到百度、腾讯等产业巨头的支持。从商业化角度看，RadixArk的成立和1亿美元融资标志着开源项目探索"开源核心+商业服务"模式的重要尝试，为后续开源AI基础设施项目提供了可借鉴的路径。

展望未来，SGLang面临的发展机遇与挑战并存。一方面，随着大模型应用场景从简单问答向复杂Agent工作流、多模态交互演进，SGLang在结构化生成和复杂程序执行方面的技术优势将更加凸显。项目对前沿模型的快速支持能力，以及在多种硬件平台上的广泛适配，使其具备了成为AI推理领域事实标准的潜力。另一方面，随着vLLM、TensorRT-LLM等竞争对手的快速迭代，以及各大云平台推出自研推理引擎，SGLang需要持续保持技术创新和社区活跃度，才能在激烈的市场竞争中维持领先地位。

对于开发者社区而言，SGLang的发展轨迹揭示了一个重要趋势：开源项目正在从单纯的技术贡献向生态建设和商业可持续演进。盛颖及其团队的经历表明，在AI基础设施领域，深厚的学术积累、敏锐的产业洞察和坚定的开源信念，是构建具有持久影响力项目的关键要素。随着RadixArk将业务从推理扩展到训练领域，SGLang的技术版图有望进一步扩大，为下一代AI模型提供更全面的基础设施支持。无论最终的市场格局如何演变，SGLang项目在技术创新、社区建设和商业探索方面的实践，都将为整个AI行业提供宝贵的经验和启示。

## 参考资料

- [SGLang 推理引擎的技术要点与部署实践｜AICon 北京站前瞻](https://t.cj.sina.cn/articles/view/5901272611/15fbe462301902vure?vt=4)
- [SGLang - Wikipedia](https://en.wikipedia.org/wiki/SGLang)
- [GitHub - sgl-project/sglang: SGLang is a high-performance serving framework for large language models and multimodal models](https://github.com/sgl-project/sglang)
- [Welcome to SGLang - SGLang Documentation](https://docs.sglang.ai/)
- [SGLang: Efficient Execution of Structured Language Model Programs (PDF)](https://arxiv.org/pdf/2312.07104)
- [原理&图解vLLM Automatic Prefix Cache(RadixAttention)](https://cloud.tencent.com/developer/article/2424704)
- [使用SGLang和vLLM部署Qwen系列模型的性能测试与评估](https://help.aliyun.com/zh/cap/user-guide/performance-comparison-of-deploying-qwen-models-using-sglang-and-vllm)
- [SGLang：比vLLM吞吐还要大5倍的推理引擎](https://developer.volcengine.com/articles/7477848955817525257)
- [对话盛颖：xAI，Infra的浪漫，SGLang，开源，平权与"甄嬛传"](https://finance.biggo.com.tw/podcast/a1b4a2b35cfd8330)
- [SGLang / RadixArk 笔记：开源贡献 + 跳槽判断](https://gist.github.com/CharryWu/4f1cff980fd6fd9f3b446db98249baf2)
- [SGLang 团队与 RadixArk 相关讨论 - X](https://x.com/GenAI_is_real/status/2084475184057037138)
- [SGLang: Efficient Execution of Structured Language Model Programs - NeurIPS 2024](https://neurips.cc/virtual/2024/poster/94872)
- [SGLang: Efficient Execution of Structured Language Model Programs (arXiv:2312.07104)](https://arxiv.org/abs/2312.07104)
- [LMSYS Org](https://lmsys.org/)
- [Ying Sheng 个人主页](https://sites.google.com/view/yingsheng/home)
- [Fast and Expressive LLM Inference with RadixAttention and SGLang - LMSYS Org](https://www.lmsys.org/blog/2024-01-17-sglang/)
- [About - LMSYS Org](https://lmsys.org/about/)
- [SGLang技术分析 - 知乎](https://zhuanlan.zhihu.com/p/711167552)
- [SGLang Deep Dive: Inside SGLang - SugiV Blog](https://blog.sugiv.fyi/sglang-deep-dive-inside-sglang)
- [SGLang vs vLLM: A Comprehensive Comparison](https://www.gpu-mart.com/blog/sglang-vs-vllm)
- [1亿美元种子轮！SGLang团队RadixArk，打造下一代开放AI基础设施](http://finance.sina.com.cn/stock/t/2026-05-08/doc-inhxerwi4210788.shtml)
- [拿下1亿美元种子轮！SGLang团队创立RadixArk](https://www.sohu.com/a/1019910884_129720)
- [AI计算极其耗费内存，一家英伟达支持的初创公司给出了对策 - 华尔街日报中文网](https://cn.wsj.com/articles/ai%25E8%25AE%25A1%25E7%25AE%2597%25E6%259E%2581%25E5%2585%25B6%25E8%2580%2597%25E8%25B4%25B9%25E5%2586%2585%25E5%25AD%2598-%25E4%25B8%2580%25E5%25AE%25B6%25E8%258B%25B1%25E4%25BC%259F%25E8%25BE%25BE%25E6%2594%25AF%25E6%258C%2581%25E7%259A%2584%25E5%2588%259D%25E5%2588%259B%25E5%2585%25AC%25E5%258F%25B8%25E7%25BB%2599%25E5%2587%25BA%25E4%25BA%2586%25E5%25AF%25B9%25E7%25AD%2596-9c24891d)
- [Sources: Project SGLang spins out as RadixArk with $400M valuation - TechCrunch](https://techcrunch.com/2026/01/21/sources-project-sglang-spins-out-as-radixark-with-400m-valuation-as-inference-market-explodes/)
- [vLLM、SGLang 融资背后，AI 推理正在走向系统化与治理](https://zhuanlan.zhihu.com/p/2000575033756639961)
- [使用SGLang 推理引擎 | DGX Spark - NVIDIA](https://developer.nvidia.cn/build-spark/sglang)
- [前端：结构化生成语言 (SGLang) — SGLang 中文文档](https://www.llamafactory.cn/sglang/frontend.html)
- [Vicuna: An Open-Source Chatbot Impressing GPT-4 with 90%* ChatGPT Quality - LMSYS Org](https://www.lmsys.org/blog/2023-03-30-vicuna/)
- [SGLang架构与实现逻辑：从RadixAttention到生产级推理](https://zhuanlan.zhihu.com/p/2067058912281485872)
- [Our $100M Seed to Build Open Infrastructure for Frontier AI - RadixArk](https://radixark.ai/blog/radixark-launches-100m-seed)
- [RadixArk IPO Timeline and Financing Details - Forge](https://forgeglobal.com/radixark_ipo/)
- [RadixArk Launches with $100 Million in Seed Funding Led by Accel - Business Wire](https://www.businesswire.com/news/home/20260505077157/en/RadixArk-Launches-with-%2524100-Million-in-Seed-Funding-Led-by-Accel-to-Grow-SGLang-and-Democratize-Frontier-AI-Infrastructure)
- [Guitar Cat + LLM (@GenAI_is_real) - X](https://x.com/GenAI_is_real/status/2051703162722263180)
- [Chip Titans Unite: NVIDIA, AMD, and Intel Jointly Invest $100M](https://finance.biggo.com/news/DqyQC54BoicNoOgCMXaM)
- [AI Computing Is a Memory Hog. An Nvidia-Backed Startup Has an Answer - WSJ](https://www.wsj.com/tech/ai/ai-computing-is-a-memory-hog-an-nvidia-backed-startup-has-an-answer-383a5710)
- [Release v0.5.20 · sgl-project/sglang - GitHub](https://github.com/sgl-project/sglang/releases/tag/v0.5.20)
