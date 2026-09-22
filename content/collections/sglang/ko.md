대규모 언어 모델(LLM) 추론 프레임워크의 경쟁 구도가 깊이 재편되고 있는 가울, SGLang은 이 분야에서 가장 혁신적인 오픈소스 프로젝트 중 하나로서 학술 연구에서 상용 운영 단계까지 발전해 왔습니다. 이 보고서는 SGLang 프로젝트의 발전 과정, 핵심 기술 아키텍처, 창립 팀의 배경, 그리고 상용화 경로를 체계적으로 정리하여 개발자 커뮤니티에 포괄적이고 깊이 있는 프로젝트 인사이트를 제공합니다.

## SGLang 창업자 성잉: ACM 대회에서 AI 인프라 최전선까지

성잉(盛颖, Ying Sheng)은 SGLang 프로젝트의 주요 발기인이자 상용화 추진자로서, 그녀의 개인적 여정 자체가 학계에서 산업으로, 오픈소스에서 비즈니스로 이어지는 흥미로운 이야기입니다. 공개 자료에 따라 성잉은 상하이자오퉁대학교 ACM 아너스 클래스에서 컴퓨터 과학 및 기술 학사 학위를 받았고, 이어 컬럼비아대학교에서 컴퓨터 과학 석사 학위를 취득한 뒤 스탠퍼드대학교 컴퓨터 과학과에서 Clark Barrett 교수의 지도 아래 박사 학위를 받았습니다. 연구 분야는 형식 검증, 머신러닝 시스템, 대규모 언어 모델을 아우릅니다. 알고리즘, 형식 방법, AI 시스템을 넘나드는 이러한 학문적 훈련은 그녀가 이후 SGLang 프로젝트의 기술 방향을 주도하는 데 든든한 기반이 되었습니다.

학계 경력 외에도 성잉은 풍부한 산업계 실무 경험을 보유하고 있습니다. 그녀는 Two Sigma에서 퀀트 소프트웨어 엔지니어로 근무했고, Facebook Novi에서 스마트 컨트랙트 검증 관련 연구 인턴십을 수행했으며, X(구 Google 문샷 팩토리)에서 Ph.D. 레지던트 연구원으로 AI for Code 관련 업무를 진행했습니다. 이러한 경험을 통해 그녀는 학술 연구와 산업 적용 사이의 간극을 깊이 이해하게 되었고, 이후 AI 인프라 분야의 혁신을 위한 학제적 시각을 갖추게 되었습니다. 특히 UC Berkeley Sky 연구실에서 방문 연구원으로 재직하며 Ion Stoica, Joseph E. Gonzalez 등 시스템 분야의 저명한 학자들과 협업한 경험은 고효율 LLM 추론 시스템에 대한 그녀의 연구 관심을 직접적으로 촉발했습니다.

2024년 10월부터 2025년 8월까지 성잉은 xAI에 합류해 추론 팀을 공동으로 이끌었으며, 일론 머스크 산하 AI 기업에서의 이 실전 경험을 통해 대규모 AI 모델 추론의 산업 수준 과제들을 깊이 접할 수 있었습니다. 그러나 그녀는 결국 xAI를 떠나 2025년 중반 RadixArk를 창업하여 SGLang 프로젝트를 상용화하기로 했으며, 이 결정은 오픈소스 AI 인프라의 가치에 대한 그녀의 깊은 신념을 보여줍니다. 성잉은 공개된 여러 자리에서 AI 인프라는 미학과 완성도를 추구해야 한다고 강조해 왔으며, 이러한 철학은 SGLang의 기술 설계와 커뮤니티 운영 전반에 관통하고 있습니다. ACM 대회 출전자에서 스탠퍼드 박사로, 다시 xAI 기술 리더를 거쳐 마침내 RadixArk의 CEO가 되기까지의 커리어 궤적은 한 기술 리더가 어떻게 학문적 이상과 상업적 현실을 결합하는지를 보여주는 본보기입니다.

## LMSYS 조직: 오픈소스 AI 생태계의 인큐베이터

SGLang 프로젝트는 고립되어 발전한 것이 아니라 LMSYS(Large Model Systems Organization)라는 독특한 오픈소스 생태계에 깊이 뿌리내리고 있습니다. LMSYS는 2023년 UC Berkeley, 스탠퍼드대학교, UC San Diego, Carnegie Mellon University, 그리고 Mohamed bin Zayed Islamic University 간의 다교 협력 프로젝트에서 시작되었으며, 2024년 9월 501(c)(3) 비영리 조직으로 공식 등록되었습니다. 이러한 학술적 배경은 LMSYS에 AI 연구 분야의 독특한 공신력을 부여하여, 학술 최전선과 산업 실무를 잇는 중요한 다리 역할을 하게 했습니다.

LMSYS의 사명은 오픈소스 모델, 데이터셋, 시스템, 평가 도구를 공동으로 개발하여 모든 사람이 대규모 인공지능 모델을 사용할 수 있게 하는 것입니다. 이 조직은 널리 영향력을 미친 여러 프로젝트를 배출했는데, FastChat은 약 3.95만 개의 GitHub 스타를 보유하고 있고, Vicuna 모델은 오픈소스 커뮤니티에서 큰 주목을 받았으며, Chatbot Arena(현 LMArena)는 세계에서 가장 영향력 있는 크라우드소싱 LLM 평가 플랫폼으로 자리 잡았습니다. LMSYS의 플래그십 프로젝트 중 하나인 SGLang은 현재 GitHub에서 3.63만 개 이상의 스타를 기록하고 있으며, 매일 전 세계 40만 개 이상의 GPU에 추론 서비스를 지원하고 있습니다. 이러한 조직 생태계는 SGLang에 기술 검증, 인재 확보, 커뮤니티 확산을 아우르는 전방위적 지원을 제공합니다.

거버넌스 구조에서 LMSYS는 학계와 산업계가 혼합된 독특한 모델을 채택했습니다. 조직의 자문 명단에는 UC Berkeley의 Joseph E. Gonzalez와 Ion Stoica, Carnegie Mellon University의 Eric P. Xing 등 저명한 학자들이 포함되어 있으며, NVIDIA, AMD, Google Cloud, a16z 등 기관의 후원도 받고 있습니다. 이러한 구조는 LMSYS 프로젝트가 학술적 엄밀성을 유지하면서도 산업계의 자원 지원을 받을 수 있게 합니다. SGLang에게 LMSYS는 법적·재정적 관리를 제공할 뿐 아니라, 더 중요하게는 프로젝트에 중립성과 공신력을 부여하여 서로 경쟁 관계에 있는 기업들(NVIDIA와 AMD 등)로부터 공동 투자와 지원을 끌어낼 수 있게 했습니다.

## SGLang 기술 발전: 학술 논문에서 프로덕션급 시스템으로

SGLang의 기술 발전 과정은 학술 프로토타입, 오픈소스 반복 개발, 상용화 가속의 세 단계로 명확히 구분할 수 있으며, 각 단계는 기술적 깊이와 적용 범위에서의 중대한 도약을 의미합니다. 프로젝트는 Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie 등 연구자들이 2023년 12월 12일 arXiv에 발표한 논문 《SGLang: Efficient Execution of Structured Language Model Programs》에서 비롯되었습니다. 이 논문은 구조화 생성 언어라는 개념을 처음 제안하여, 당시 LLM 프로그래밍에 효율적인 실행 시스템이 부족하다는 문제를 해결하고자 했습니다. 이후 NeurIPS 2024에서 이 논문이 정식 채택되면서, 학계가 SGLang의 기술 방향을 높이 인정했음이 확인되었습니다.

2024년 1월 17일, LMSYS 팀은 공식 블로그를 통해 SGLang 프로젝트를 대외에 정식 공개하고 코드 구현을 오픈소스로 발표했습니다. 이 버전의 SGLang은 이미 프런트엔드/백엔드 공동 설계라는 핵심 철학을 보여주었습니다. 백엔드는 RadixAttention으로 KV 캐시의 자동 재사용을 구현하고, 프런트엔드는 Python에 내장된 도메인 특화 언어(DSL)를 제공해 생성 과정을 제어합니다. 프로젝트 초기 성능 테스트에서 NVIDIA A10G GPU 상에서 Llama-7B와 Mixtral-8x7B 모델을 사용할 때, SGLang의 처리량은 당시의 최첨단 시스템(Guidance와 vLLM)보다 최대 5배 높았고, 특히 첫 토큰 지연(TTFT) 측면에서 프리픽스 캐시 히트가 상당한 이점을 가져왔습니다.

2024년에 들어 SGLang은 빠른 버전 반복을 거쳤습니다. v0.2는 Llama3 서빙 지원을 추가했고, v0.3은 DeepSeek MLA 최적화를 도입했으며, v0.4에 이르러 프로젝트는 제로 오버헤드 스케줄러, Cache-Aware Router, 데이터 병렬 어텐션(DPA), xGrammar 구조화 생성 등 핵심 기능을 갖추게 되었습니다. 이 단계에서 SGLang은 연구 프로토타입에서 프로덕션 배포가 가능한 추론 엔진으로 탈바꿈하기 시작하며, 더 넓은 범위의 모델과 하드웨어 플랫폼을 지원하기 시작했습니다.

2025년은 SGLang의 기술적 성숙이 이루어진 결정적인 해였습니다. v0.5 릴리스는 프로젝트가 구조화 생성, 멀티모달 지원, 하드웨어 적응 측면에서 새로운 수준에 도달했음을 보여줍니다. 이 버전은 비전 언어 모델(VLM) 지원을 확장했을 뿐 아니라 xGrammar를 통해 더 효율적인 구조화 출력 생성을 실현했습니다. 이와 동시에 SGLang은 DeepSeek 시리즈 모델의 배포를 지원하기 시작했고, 완전 오픈소스 기반의 첫 DeepSeek 대규모 전문가 병렬화 배포 솔루션이 되었습니다. 이러한 기술 진보는 2026년 SGLang의 폭발적 성장을 위한 기술적 토대를 마련했습니다.

2026년 9월 기준, SGLang은 v0.5.20 버전까지 발전했으며, 이 버전에는 237명의 기여자가 제출한 713개의 PR이 누적 병합되어 있습니다. 새 버전은 GLM-5.3-Flash, Qwen3.8-Flash-Next, K2 Horizon 등 여러 최첨단 모델에 대한 지원을 추가하고, 통합 래딕스 트리(Radix Tree) 최적화, 디코딩 컨텍스트 병렬화, SGLang 시뮬레이터 등 혁신 기능을 구현했습니다. 특히 통합 래딕스 트리 최적화는 DeepSeek-V4-Flash의 토큰 히트율을 43.8%에서 60.8%로 끌어올리고, 평균 첫 토큰 지연을 1.57초에서 1.07초로 단축하여, 프로젝트가 기술 최적화에 지속적으로 투자하고 있음을 보여주었습니다.

## SGLang 핵심 기술 아키텍처: 프런트엔드/백엔드 공동 설계

SGLang의 기술 아키텍처는 "프런트엔드/백엔드 공동 설계"라는 핵심 철학을 구현하며, 이 설계 철학은 SGLang을 전통적인 추론 프레임워크와 구별 짓습니다. 구체적으로 SGLang은 프런트엔드 구조화 생성 언어와 백엔드 고성능 런타임의 두 부분으로 구성되며, 이 둘은 긴밀하게 협력하여 복잡한 LLM 프로그램의 효율적인 실행을 실현합니다. 이러한 아키텍처 설계의 근본적인 출발점은, 현대 AI 애플리케이션이 더 이상 단순한 단일 모델 호출에 그치지 않고 멀티턴 대화, 도구 호출, 구조화 출력 등 복잡한 프로그래밍적 상호작용 패턴을 필요로 한다는 인식에 있습니다.

백엔드 핵심 기술 측면에서 **RadixAttention**은 의심할 여지 없이 SGLang의 가장 혁신적인 기여입니다. 이 기술은 래딕스 트리(Radix Tree) 자료구조를 기반으로 KV 캐시의 자동 재사용을 구현하여, 멀티턴 대화, few-shot 학습, 사고 트리 등 시나리오에 존재하는 중복 계산 문제를 해결합니다. 요청이 완료된 후 KV 캐시를 폐기하는 전통적인 시스템과 달리, RadixAttention은 프롬프트와 생성 결과의 KV 캐시를 래딕스 트리에 보관하고, 효율적인 프리픽스 검색, 삽입, 제거 메커니즘을 통해 요청 간 캐시 공유를 실현합니다. 시스템은 또한 최근 최소 사용(LRU) 제거 정책과 캐시 인식 스케줄링 알고리즘을 구현하여, 대기 큐에 여러 요청이 있을 때 더 긴 매칭 프리픽스를 가진 요청을 우선 처리함으로써 캐시 히트율을 최대화합니다. 실험에 따륩 전형적인 멀티턴 대화 시나리오에서 RadixAttention은 캐시 히트율을 3~5배 높여 응답 지연을 크게 줄일 수 있습니다.

SGLang의 백엔드에는 여러 성능 최적화 기술도 포함되어 있습니다. **제로 오버헤드 스케줄러**는 CPU/GPU 중첩 실행 메커니즘을 통해 GPU가 현재 배치를 실행하는 동안 다음 배치를 비동기적으로 준비함으로써 95% 이상의 GPU 활용률을 달성합니다. 이 설계는 전통적인 추론 시스템에서 CPU 스케줄링이 병목이 되어 GPU가 유휴 상태로 대기하는 문제를 해결합니다. **연속 배칭**(Continuous Batching)은 시스템이 런타임에 배치 크기를 동적으로 조정하여 새로 도착한 요청을 처리 중인 요청과 병합 실행함으로써 처리량을 최대화합니다. 또한 SGLang은 페이지드 어텐션, 텐서 병렬화, 파이프라인 병렬화, 전문가 병렬화 등 다양한 병렬 전략과 FP4/FP8/INT4 등 다양한 양자화 방식을 지원하여, 단일 카드 환경부터 대규모 분산 클러스터까지 다양한 배포 시나리오에 적응할 수 있습니다.

프런트엔드 설계 측면에서 SGLang은 Python에 내장된 도메인 특화 언어(DSL)를 제공하여, 개발자가 선언적 방식으로 복잡한 LLM 프로그램을 작성할 수 있게 합니다. 이 DSL은 gen, select, fork, image 등의 프리미티브를 제공하며, 제어 흐름, 병렬성, 멀티모달 입력, 제약 디코딩 등 고급 기능을 지원합니다. 예를 들어 개발자는 fork 프리미티브로 여러 개의 병렬 프롬프트 복사본을 만들고, gen 프리미티브로 논블로킹 생성 호출을 수행하거나, regex 매개변수를 통해 정규식으로 제약된 구조화 출력을 구현할 수 있습니다. 이러한 프런트엔드 언어의 설계 목표는 LangChain과 같은 전통적인 오케스트레이션 프레임워크를 대체하여, 인터프리터 실행 또는 그래프 실행 방식으로 더 높은 실행 효율을 달성하는 것입니다.

주목할 점은 SGLang의 구조화 생성 역량이 업계 선두권에 있다는 것입니다. 압축 유한 상태 기계(FSM)와 xGrammar 문법 엔진을 통해 SGLang은 생성된 텍스트가 JSON Schema, 정규식 또는 문맥 자유 문법으로 정의된 제약을 엄격히 준수하도록 보장하며, 후처리나 재시도가 필요하지 않습니다. 이 역량은 정확한 출력 형식이 필요한 기업용 애플리케이션(API 응답 생성, 데이터베이스 쿼리 구축 등)에 중요한 가치를 제공합니다. SGLang v0.5.20 버전에서 프로젝트는 샘플링 마스크 캡처와 중첩 스케줄링 기능을 도입하여, Qwen3-8B 모델에서 17%(batch=1)부터 52%(batch=64)에 이르는 디코딩 처리량 향상을 달성했습니다.

## 상용화 경로: RadixArk의 설립과 AI 추론 시장 구도

SGLang 프로젝트의 상용화 과정은 2025년부터 2026년 사이에 뚜렷하게 가속화되었고, 마침내 RadixArk의 설립으로 이어졌으며, 이는 오픈소스 AI 인프라 프로젝트가 비즈니스 모델을 모색하는 과정의 중요한 이정표가 되었습니다. 2025년 7월부터 8월 사이 성잉과 핵심 팀원들은 각자의 직장을 떠나 SGLang 생태계 구축에 전임으로 전념할지를 논의하기 시작했습니다. 심사숙고 끝에 팀은 SGLang을 기반으로 상용 회사 RadixArk를 설립하기로 결정했고, 성잉이 CEO를 맡았으며, 공동 창업자로는 NVIDIA 출신의 Banghua Zhu가 CTO를 맡았습니다.

2026년 1월, TechCrunch 등 권위 있는 테크 미디어가 RadixArk의 투자 유치 소식을 처음 보도하며, SGLang 프로젝트가 약 4억 달러의 기업가치로 독립 회사로 분사될 것이라고 전했습니다. 이어 2026년 5월 5일 RadixArk은 1억 달러 규모의 시드 투자 유치를 공식 발표했고, 투자 후 기업가치는 4억 달러에 달했으며, Accel이 주도하고 Spark Capital이 공동 주도했습니다. 이 투자는 2026년 AI 인프라 분야에서 가장 주목받는 초기 투자 중 하나로 꼽히는데, 그 금액과 기업가치 규모뿐 아니라 투자자 라인업의 화려함 때문이기도 합니다.

RadixArk의 투자자 명단은 AI 산업 체인의 거의 모든 핵심 참여자를 망라하고 있습니다. 주도 투자자인 Accel과 Spark Capital 외에도 NVIDIA의 벤처캐피털 부문 NVentures, AMD, MediaTek 등 칩 대기업들, 그리고 Salience Capital, A&E Investments, HOF Capital, Walden International 등 유명 투자 기관이 포함되어 있습니다. 특히 주목할 점은 평소 경쟁 관계에 있는 NVIDIA와 AMD라는 두 칩 회사가 드물게 한 스타트업에 공동 투자했다는 사실로, 이는 RadixArk 기술의 전략적 가치를 여실히 보여줍니다. 월스트리트저널 보도에 의하면 Broadcom CEO인 Hock Tan도 이번 라운드 투자에 참여했습니다. 이러한 산업 체인을 가로지르는 투자 구도는 업계가 RadixArk의 AI 추론 최적화 기술 방향에 변혁적 잠재력이 있다고 보편적으로 평가하고 있음을 보여줍니다.

비즈니스 모델 측면에서 RadixArk은 SGLang을 중심으로 상용 서비스를 전개하는 한편, 오픈소스 개발도 지속적으로 추진할 계획입니다. 알려진 바에 의하면 회사의 사업은 추론에서 모델 훈련 영역으로 확장되어, 최첨단 AI 모델을 위한 개방형 인프라를 제공하는 것을 목표로 합니다. 주목할 점은 RadixArk이 상용화되었음에도 SGLang 프로젝트는 여전히 비영리 조직 LMSYS 산하에 호스팅되어 오픈소스의 독립성을 유지하고 있다는 것입니다. 이러한 "오픈소스 코어 + 상용 서비스" 모델은 Linux Foundation, MongoDB 등 성공적인 오픈소스 프로젝트의 비즈니스 경로와 유사하며, 기술의 개방성과 커뮤니티 활력을 보장하는 동시에 기업 고객에게 전문적인 기술 지원과 서비스 보장을 제공합니다.

## 생태계 구축과 산업 적용: 실험실에서 40만 GPU로

SGLang의 기술적 가치는 궁극적으로 광범위한 산업 적용과 방대한 배포 규모에서 드러납니다. 공식 문서에 의하면 2026년 기준 SGLang은 전 세계적으로 40만 개 이상의 GPU에서 실행되고 있으며, 매일 프로덕션 환경에서 수조 개의 토큰을 처리합니다. 이러한 배포 규모는 SGLang을 현재 AI 추론 분야의 사실상 표준 중 하나로 만들었으며, SGLang은 vLLM, TensorRT-LLM 등 프레임워크와 함께 대규모 모델 배포의 인프라 계층을 구성하고 있습니다.

SGLang의 산업 적용은 클라우드 서비스 제공자부터 최종 사용자까지 전체 산업 체인을 포괄합니다. 클라우드 서비스 분야에서는 AWS, Google Cloud, Microsoft Azure, Oracle Cloud 등 주요 클라우드 플랫폼이 모두 SGLang 배포를 지원합니다. 하드웨어 제조사 측면에서는 NVIDIA, AMD, Intel이 RadixArk에 투자했을 뿐 아니라 각자의 제품 라인과 문서에서 SGLang을 적극적으로 소개하고 있습니다. 중국 테크 기업 중에서는 바이두, 알리바바, 텐센트, 앤트 그룹 등 선두 기업들도 프로덕션 환경에서 SGLang을 채택해 대규모 모델 추론을 수행하고 있습니다. 또한 Cursor, LinkedIn, xAI 등 혁신적인 기업들 역시 SGLang의 성능과 안정성을 신뢰하고 있습니다.

SGLang은 복잡한 상호작용 패턴이 필요한 AI 애플리케이션 시나리오에 특히 적합합니다. 멀티턴 대화 시스템에서는 RadixAttention의 프리픽스 캐시 메커니즘이 지연을 눈에 띄게 낮추어 사용자 경험을 향상시킵니다. AI 에이전트 워크플로에서는 SGLang의 DSL 언어를 통해 개발자가 도구 호출, 병렬 추론, 상태 관리 등 복잡한 로직을 손쉽게 표현할 수 있습니다. 구조화 출력 시나리오(JSON 생성, API 응답 포매팅 등)에서는 SGLang의 제약 디코딩 역량이 출력의 유효성과 일관성을 보장하여, 전통적인 방법에서 흔히 발생하는 형식 오류 문제를 방지합니다. 이러한 특성들은 SGLang을 차세대 AI 애플리케이션 구축을 위한 대표적인 추론 엔진 중 하나로 만들어 줍니다.

모델 지원 측면에서 SGLang은 매우 강력한 생태계 호환성을 보여줍니다. 프로젝트는 Llama, Qwen, DeepSeek, Kimi, GLM, GPT, Gemma, Mistral 등 주요 언어 모델과 e5-mistral, gte 등 임베딩 모델, Skywork 등 리워드 모델을 지원합니다. 비전 및 오디오 분야에서는 LLaVA, Qwen-VL 등 멀티모달 모델과 WAN, Qwen-Image 등 확산 모델을 지원합니다. 특히 주목할 점은 SGLang의 최첨단 모델 지원 속도가 매우 빠르다는 것으로, 보통 모델이 발표된 당일 또는 며칠 이내에 완전한 추론 지원을 제공합니다. 예를 들어 2026년 7월 SGLang은 Miles 프레임워크와 함께 Kimi K3 모델에 첫날 지원을 제공했고, 2026년 9월에는 DeepSeek-V4.1에 대한 빠른 통합을 제공했습니다.

하드웨어 적응의 광범위함 역시 SGLang 생태계 구축의 중요한 축입니다. 프로젝트는 NVIDIA의 전 제품군 GPU(소비자급 RTX 5090부터 데이터센터용 GB200/B300/H100까지)를 지원할 뿐 아니라, AMD MI355/MI300 시리즈, Intel Xeon CPU, Google TPU, 화웨이 Ascend NPU, Moore Threads MUSA 등 자국산 하드웨어 플랫폼도 지원합니다. 이러한 크로스 플랫폼 역량은 SGLang이 서로 다른 사용자의 하드웨어 환경과 비용 제약에 적응할 수 있게 하며, 특히 현재의 AI 칩 다원화 추세 속에서 중요한 전략적 의미를 지닙니다.

## SGLang과 vLLM: 기술 방향의 경쟁과 협력 관계

오픈소스 LLM 추론 프레임워크 분야에서 SGLang과 vLLM은 가장 대표적인 두 프로젝트로, 서로 경쟁 관계에 있으면서도 기술 발전 과정에서 상호 참조하며 함께 업계의 발전을 이끌어 왔습니다. 두 프로젝트의 차이와 각자의 강점을 이해하면, 개발자가 구체적인 애플리케이션 시나리오에 맞는 합리적인 기술 선택을 하는 데 도움이 됩니다.

설계 철학 측면에서 vLLM은 UC Berkeley의 Sky Computing Lab이 개발했으며, 핵심 혁신은 PagedAttention 기술입니다. 이는 운영체제의 페이징 메커니즘을 차용하여 KV 캐시를 고정 크기 블록으로 나누고 동적 메모리 할당을 구현함으로써 메모리 효율을 3~4배 높이고 더 높은 동시성을 지원합니다. 이에 비해 SGLang의 설계는 프런트엔드/백엔드 공동 설계를 더 강조하며, 단일 추론의 효율뿐 아니라 복잡한 LLM 프로그램(여러 차례의 모델 호출, 제어 흐름, 구조화 출력이 얽힌 프로그램)의 전체 실행 효율을 최적화하는 데 주력합니다. 이러한 설계 목표의 차이가 서로 다른 시나리오에서 두 프로젝트의 성능 차이를 결정합니다.

성능 벤치마크 측면에서 여러 독립 테스트는 SGLang이 멀티턴 대화와 구조화 출력 시나리오에서 뚜렷한 우위를 보임을 나타냅니다. 알리바바 클라우드의 2025년 6월 테스트 데이터에 의하면, 단일 카드로 Qwen 시리즈 모델을 배포할 때 SGLang의 첫 토큰 지연(TTFT)은 vLLM보다 약 18% 우수했고, 토큰당 출력 지연(TPOT)은 10%에서 15% 우수했습니다. 더 복잡한 워크로드에서는 SGLang의 우위가 더욱 커집니다. 예를 들어 멀티턴 대화와 few-shot 학습이 관련된 시나리오에서 SGLang의 처리량은 vLLM보다 최대 5배 높았는데, 이는 주로 RadixAttention의 프리픽스 캐시 메커니즘 덕분입니다. 다만 고동시성의 단일턴 추론 시나리오에서는 vLLM이 성숙한 메모리 관리와 스케줄링 메커니즘을 바탕으로 대체로 더 안정적인 성능을 보여줍니다.

기술 생태계 측면에서 vLLM은 더 큰 커뮤니티 규모와 더 넓은 모델 지원을 보유하고 있습니다. vLLM의 GitHub 스타 수는 SGLang을 앞서고, API 설계도 Hugging Face 생태계에 더 가까워, 기존 프로젝트를 빠르게 마이그레이션하려는 개발자에게 진입 장벽이 낮습니다. 이에 비해 SGLang은 학습 곡선이 가파른 편이며, 개발자가 프레임워크의 고급 기능을 충분히 활용하려면 DSL 언어를 익혀야 합니다. 그러나 SGLang은 구조화 생성, 멀티모달 처리, 분산 캐시 등 최전선 분야에서의 기술적 깊이 덕분에, 복잡한 AI 애플리케이션을 구축할 때 대체하기 어려운 강점을 지닙니다.

주목할 점은 두 프로젝트가 순수한 경쟁 관계만은 아니라는 것입니다. SGLang의 GitHub 페이지는 vLLM, Guidance, LightLLM, FlashInfer 등 프로젝트의 설계와 코드 재사용에 명시적으로 감사를 표하고 있으며, vLLM 역시 2024년에 Automatic Prefix Caching 기능을 도입했는데, 이는 기술적으로 SGLang의 RadixAttention과 다른 접근으로 같은 효과를 노린다는 점에서 맥을 같이합니다. 이러한 상호 참조는 오픈소스 추론 프레임워크 생태계 전체의 기술 진보를 이끌었습니다. 2026년 초 vLLM 핵심 팀 역시 상용 회사 Inferact를 설립하여 1.5억 달러의 투자를 유치했고, 기업가치는 8억 달러에 달했습니다. SGLang과 vLLM이 잇달아 상용화로 향한 것은 오픈소스 대규모 모델 추론 엔진이 기술 탐색 단계에서 산업 적용 단계로 진입했음을 보여주며, AI 추론 시장이 체계화와 전문화된 거버넌스로 나아가고 있음을 의미합니다.

## 결론과 전망

SGLang 프로젝트의 발전 과정은 오픈소스 AI 인프라의 진화를 보여주는 매우 가치 있는 사례 연구입니다. 기술적 관점에서 SGLang은 프런트엔드/백엔드 공동 설계와 RadixAttention 등 핵심 혁신을 통해 복잡한 LLM 프로그램 실행에서의 효율 병목을 성공적으로 해결했고, 구조화 생성, 멀티턴 대화 등 시나리오에서 뚜렷한 기술적 우위를 보여주었습니다. 생태계 관점에서 SGLang은 LMSYS 조직의 학술적 배경과 중립성에 기반하여 산업계, 학계, 연구계를 아우르는 광범위한 협력 네트워크를 구축했고, NVIDIA, AMD부터 바이두, 텐센트에 이르는 산업 거인들의 지원을 받았습니다. 상용화 관점에서 RadixArk의 설립과 1억 달러 투자 유치는 오픈소스 프로젝트가 "오픈소스 코어 + 상용 서비스" 모델을 모색하는 중요한 시도로, 이후의 오픈소스 AI 인프라 프로젝트들이 참고할 수 있는 경로를 제공합니다.

미래를 전망하면 SGLang 앞에는 발전 기회와 도전이 공존합니다. 한편으로는 대규모 모델의 애플리케이션 시나리오가 단순한 질의응답에서 복잡한 에이전트 워크플로와 멀티모달 상호작용으로 진화함에 따라, SGLang의 구조화 생성과 복잡한 프로그램 실행 측면의 기술적 우위는 더욱 부각될 것입니다. 최첨단 모델에 대한 빠른 지원 역량과 다양한 하드웨어 플랫폼에 대한 광범위한 적응력은 SGLang이 AI 추론 분야의 사실상 표준이 될 잠재력을 갖추게 합니다. 다른 한편으로는 vLLM, TensorRT-LLM 등 경쟁 프로젝트의 빠른 반복 개발과 주요 클라우드 플랫폼들의 자체 추론 엔진 출시 속에서, SGLang은 기술 혁신과 커뮤니티 활성도를 지속적으로 유지해야만 치열한 시장 경쟁 속에서 선두를 지킬 수 있습니다.

개발자 커뮤니티의 관점에서 SGLang의 발전 궤적은 하나의 중요한 추세를 드러냅니다. 오픈소스 프로젝트가 단순한 기술 기여에서 생태계 구축과 상업적 지속 가능성으로 진화하고 있다는 것입니다. 성잉과 그녀의 팀의 경험이 보여주듯, AI 인프라 분야에서 깊이 있는 학술적 축적, 예리한 산업 통찰, 그리고 굳건한 오픈소스 신념은 지속적인 영향력을 지닌 프로젝트를 만드는 핵심 요소입니다. RadixArk이 사업을 추론에서 훈련 영역으로 확장함에 따라 SGLang의 기술 지형도 더욱 확대되어, 차세대 AI 모델에 더 포괄적인 인프라 지원을 제공할 것으로 기대됩니다. 최종적인 시장 구도가 어떻게 변화하든, 기술 혁신, 커뮤니티 구축, 상업적 탐색에서 SGLang 프로젝트가 보여준 실천은 AI 업계 전체에 귀중한 경험과 시사점을 제공할 것입니다.

## 참고 자료

- [SGLang 추론 엔진의 기술 요점과 배포 실천｜AICon 베이징 미리 보기](https://t.cj.sina.cn/articles/view/5901272611/15fbe462301902vure?vt=4)
- [SGLang - Wikipedia](https://en.wikipedia.org/wiki/SGLang)
- [GitHub - sgl-project/sglang: SGLang is a high-performance serving framework for large language models and multimodal models](https://github.com/sgl-project/sglang)
- [Welcome to SGLang - SGLang Documentation](https://docs.sglang.ai/)
- [SGLang: Efficient Execution of Structured Language Model Programs (PDF)](https://arxiv.org/pdf/2312.07104)
- [vLLM Automatic Prefix Cache(RadixAttention) 원리와 도해](https://cloud.tencent.com/developer/article/2424704)
- [SGLang과 vLLM을 사용해 Qwen 시리즈 모델을 배포하는 성능 테스트와 평가](https://help.aliyun.com/zh/cap/user-guide/performance-comparison-of-deploying-qwen-models-using-sglang-and-vllm)
- [SGLang: vLLM보다 처리량이 5배 더 큰 추론 엔진](https://developer.volcengine.com/articles/7477848955817525257)
- [성잉과의 대화: xAI, 인프라의 로맨스, SGLang, 오픈소스, 평등 그리고 "견환전"](https://finance.biggo.com.tw/podcast/a1b4a2b35cfd8330)
- [SGLang / RadixArk 노트: 오픈소스 기여 + 이직 판단](https://gist.github.com/CharryWu/4f1cff980fd6fd9f3b446db98249baf2)
- [SGLang 팀과 RadixArk 관련 논의 - X](https://x.com/GenAI_is_real/status/2084475184057037138)
- [SGLang: Efficient Execution of Structured Language Model Programs - NeurIPS 2024](https://neurips.cc/virtual/2024/poster/94872)
- [SGLang: Efficient Execution of Structured Language Model Programs (arXiv:2312.07104)](https://arxiv.org/abs/2312.07104)
- [LMSYS Org](https://lmsys.org/)
- [Ying Sheng 개인 홈페이지](https://sites.google.com/view/yingsheng/home)
- [Fast and Expressive LLM Inference with RadixAttention and SGLang - LMSYS Org](https://www.lmsys.org/blog/2024-01-17-sglang/)
- [About - LMSYS Org](https://lmsys.org/about/)
- [SGLang 기술 분석 - 즈후](https://zhuanlan.zhihu.com/p/711167552)
- [SGLang Deep Dive: Inside SGLang - SugiV Blog](https://blog.sugiv.fyi/sglang-deep-dive-inside-sglang)
- [SGLang vs vLLM: A Comprehensive Comparison](https://www.gpu-mart.com/blog/sglang-vs-vllm)
- [1억 달러 시드 라운드! SGLang 팀의 RadixArk, 차세대 개방형 AI 인프라 구축](http://finance.sina.com.cn/stock/t/2026-05-08/doc-inhxerwi4210788.shtml)
- [1억 달러 시드 라운드 확보! SGLang 팀이 RadixArk를 창립](https://www.sohu.com/a/1019910884_129720)
- [AI 컴퓨팅은 메모리를 극도로 소모한다, NVIDIA가 지원하는 한 스타트업이 해법을 내놓다 - 월스트리트저널 중국어판](https://cn.wsj.com/articles/ai%25E8%25AE%25A1%25E7%25AE%2597%25E6%259E%2581%25E5%2585%25B6%25E8%2580%2597%25E8%25B4%25B9%25E5%2586%2585%25E5%25AD%2598-%25E4%25B8%2580%25E5%25AE%25B6%25E8%258B%25B1%25E4%25BC%259F%25E8%25BE%25BE%25E6%2594%25AF%25E6%258C%2581%25E7%259A%2584%25E5%2588%259D%25E5%2588%259B%25E5%2585%25AC%25E5%258F%25B8%25E7%25BB%2599%25E5%2587%25BA%25E4%25BA%2586%25E5%25AF%25B9%25E7%25AD%2596-9c24891d)
- [Sources: Project SGLang spins out as RadixArk with $400M valuation - TechCrunch](https://techcrunch.com/2026/01/21/sources-project-sglang-spins-out-as-radixark-with-400m-valuation-as-inference-market-explodes/)
- [vLLM과 SGLang의 투자 유치 이면에서 AI 추론은 체계화와 거버넌스로 나아가고 있다](https://zhuanlan.zhihu.com/p/2000575033756639961)
- [SGLang 추론 엔진 사용하기 | DGX Spark - NVIDIA](https://developer.nvidia.cn/build-spark/sglang)
- [프런트엔드: 구조화 생성 언어 (SGLang) — SGLang 중국어 문서](https://www.llamafactory.cn/sglang/frontend.html)
- [Vicuna: An Open-Source Chatbot Impressing GPT-4 with 90%* ChatGPT Quality - LMSYS Org](https://www.lmsys.org/blog/2023-03-30-vicuna/)
- [SGLang 아키텍처와 구현 로직: RadixAttention에서 프로덕션급 추론까지](https://zhuanlan.zhihu.com/p/2067058912281485872)
- [Our $100M Seed to Build Open Infrastructure for Frontier AI - RadixArk](https://radixark.ai/blog/radixark-launches-100m-seed)
- [RadixArk IPO Timeline and Financing Details - Forge](https://forgeglobal.com/radixark_ipo/)
- [RadixArk Launches with $100 Million in Seed Funding Led by Accel - Business Wire](https://www.businesswire.com/news/home/20260505077157/en/RadixArk-Launches-with-%2524100-Million-in-Seed-Funding-Led-by-Accel-to-Grow-SGLang-and-Democratize-Frontier-AI-Infrastructure)
- [Guitar Cat + LLM (@GenAI_is_real) - X](https://x.com/GenAI_is_real/status/2051703162722263180)
- [Chip Titans Unite: NVIDIA, AMD, and Intel Jointly Invest $100M](https://finance.biggo.com/news/DqyQC54BoicNoOgCMXaM)
- [AI Computing Is a Memory Hog. An Nvidia-Backed Startup Has an Answer - WSJ](https://www.wsj.com/tech/ai/ai-computing-is-a-memory-hog-an-nvidia-backed-startup-has-an-answer-383a5710)
- [Release v0.5.20 · sgl-project/sglang - GitHub](https://github.com/sgl-project/sglang/releases/tag/v0.5.20)
