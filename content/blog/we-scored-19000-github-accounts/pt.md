---
title: "Medindo atividade de contribuição fabricada no GitHub: evidências de 19.000 contas pontuadas deterministicamente"
description: "Um estudo empírico sobre a autenticidade das contribuições no GitHub. Pontuamos 18.947 contas públicas com um motor determinístico open source e analisamos as distribuições de pontuação, a prevalência e a estrutura do farming de pull requests, a composição dos sinais de alerta e a relação entre idade da conta e pontuação."
date: "2026-07-03"
tags: ["data", "github", "anti-abuse", "open-source"]
---

**Resumo.** Preocupações com atividade fabricada no GitHub — pull requests em template, stars compradas, redes de seguidores recíprocos — são generalizadas, mas evidências quantitativas sobre sua prevalência e estrutura são escassas. Pontuamos 18.947 contas públicas do GitHub com uma rubrica determinística e open source (sem chamadas a modelos; entradas idênticas produzem pontuações idênticas) e retemos snapshots completos de métricas brutas para uma amostra profunda de 3.444 contas. Constatamos que (i) a fabricação é rara em nossa amostra: apenas 0,58% das contas excedem nosso limiar conservador de farming; (ii) quando ocorre, ela é extrema e bimodalmente separada do comportamento comum — contas sinalizadas têm proporções de títulos de PR em template acima de 50% (chegando a 97%), contra uma mediana populacional de 7%; (iii) contribuições de baixo esforço são normais, não suspeitas: 58% dos desenvolvedores com uma amostra recente de PRs mesclados têm ao menos um PR externo trivial, enquanto apenas 0,4% exibem um padrão majoritariamente trivial em volume; e (iv) o perfil "de aparência suspeita" dominante é vazio, não manipulado — sinais de alerta do tipo ausência superam os do tipo manipulação por uma ordem de magnitude. A pontuação mediana cresce monotonicamente com a idade da conta, de 18 pontos abaixo de um ano para 86 pontos além de dez anos, consistente com a consistência de longo prazo ser o sinal menos suscetível à fabricação. Discutimos implicações para o design de ferramentas de detecção de spam, em particular que o farming é uma propriedade em nível de padrão do histórico de uma conta, e não uma propriedade em nível de evento de contribuições individuais.

## 1. Introdução

Avaliações de credibilidade de desenvolvedores dependem cada vez mais da atividade pública no GitHub: pipelines de contratação filtram perfis de candidatos, mantenedores open source fazem triagem de pull requests de contribuidores desconhecidos, e ferramentas derivadas ranqueiam contas por impacto aparente. Cada um desses usos cria um incentivo para fabricar os sinais subjacentes. Relatos anedóticos de mercados de stars, campanhas de pull requests em template e esquemas de seguidores recíprocos são comuns; medições sistemáticas de com que frequência tal fabricação ocorre, e que forma estatística ela assume, não são.

Um exemplo motivador do nosso conjunto de dados ilustra o fenômeno. Uma conta apresenta um histórico de PRs mesclados que normalmente indicaria um contribuidor forte: um grande número de pull requests mesclados (não apenas abertos) com uma taxa de aceitação quase perfeita. Uma inspeção mais próxima mostra que 97% dos títulos recentes de seus PRs são variantes de template quase idênticas, e que a maioria mira um único repositório popular que não pertence à conta. Nenhum pull request individual é anômalo; a anomalia existe apenas no nível do padrão agregado. Essa observação — de que a fabricação pode ser invisível evento a evento, mas conspícua em agregado — motiva o presente estudo.

Fazemos três perguntas:

1. **Prevalência.** Quão comum é a atividade de contribuição fabricada entre contas públicas do GitHub?
2. **Estrutura.** Quando a fabricação ocorre, como ela difere estatisticamente do comportamento de contribuição comum?
3. **Composição.** Entre contas que disparam heurísticas de integridade, que fração reflete manipulação ativa versus mera inatividade ou ausência de trabalho original?

Para respondê-las, pontuamos 18.947 contas públicas com uma rubrica determinística ([ghfind](https://ghfind.com)), cujo núcleo de pontuação é open source sob AGPL ([repositório](https://github.com/hikariming/ghfind)), e analisamos uma amostra profunda de 3.444 contas para as quais retemos snapshots completos de métricas brutas, incluindo amostras em nível de PR, atributos de qualidade de repositório e estatísticas de formato de atividade. Todos os dados agregados por trás das figuras estão publicados junto com este artigo ([data.json](/blog/we-scored-19000-github-accounts/data.json)).

Em resumo, a fabricação é substancialmente mais rara nesta amostra do que o discurso público sugere; quando presente, é extrema em vez de sutil; e pode ser separada da atividade comum apenas com limiares simples em nível de padrão.

## 2. Dados e metodologia

### 2.1 Rubrica de pontuação

O motor implementa uma rubrica determinística sobre seis dimensões que somam 100 pontos, com penalidades aditivas para sinais de alerta. Ele não faz chamadas a modelos; as pontuações são totalmente reproduzíveis a partir de dados públicos do GitHub. Os mesmos caminhos de código produzem as pontuações usadas pelo site do ghfind, pelos SDKs de npm/PyPI e por esta análise.

| Dimensão | Máx | Sinal recompensado |
|---|---|---|
| Qualidade das contribuições | 27 | PRs mesclados (escala logarítmica), taxa de aceitação, participação em issues |
| Impacto no ecossistema | 20 | PRs substantivos em repositórios de muitas stars, profundidade como mantenedor |
| Qualidade dos projetos originais | 18 | stars ponderadas pela substância do repositório |
| Autenticidade da atividade | 17 | atividade recente sustentada, diversidade de tipos de atividade |
| Maturidade da conta | 10 | idade da conta, anos de atividade real |
| Influência na comunidade | 8 | seguidores (escala logarítmica), plausibilidade da proporção seguidor/seguindo |

Doze regras determinísticas de alerta subtraem pontos, incluindo `templated_pr_flooding`, `trivial_pr_farming`, `follow_farming` e `possible_star_inflation`. Os limiares exatos estão disponíveis no repositório. Além da pontuação pública, o motor computa uma pontuação interna de probabilidade de spam/bot em uma escala de 0–10, usada para proteger a integridade do leaderboard; a Seção 3.2 relata sua distribuição pela primeira vez. Nenhum outro dado não público entra nesta análise.

**Definições.** Chamamos um pull request de *trivial* se ele altera no máximo cinco linhas e é mesclado em um repositório com pelo menos 200 stars que o autor não possui. A *proporção de títulos em template* de uma conta é a fração de seus títulos recentes de PR que são variantes de template quase idênticas entre si.

### 2.2 Construção da amostra e vieses conhecidos

A amostra compreende (a) usuários que voluntariamente pontuaram as próprias contas pelo site do ghfind e (b) desenvolvedores ingeridos de organizações open source ativas. Duas propriedades desse desenho restringem a interpretação. Primeiro, a amostra é autosselecionada e tende a desenvolvedores genuínos e ativos; toda taxa de fabricação relatada abaixo deve, portanto, ser lida como um **limite inferior dentro de uma população já filtrada**, e não como uma estimativa para o GitHub inteiro. Segundo, com 18.947 contas pontuadas (3.444 com métricas profundas), a amostra é grande o suficiente para caracterizar o formato da distribuição, mas é uma fração desprezível do GitHub; relatamos formatos, não um censo.

## 3. Resultados

### 3.1 Distribuição das pontuações

![Distribuição das pontuações finais em 19 mil contas](/blog/we-scored-19000-github-accounts/score-distribution.svg "Figura 1: Distribuição das pontuações finais em faixas de 5 pontos (n = 18.947). Faixas laranja marcam os níveis 70+.")

A *Figura 1* mostra a distribuição das pontuações finais. A mediana fica pouco acima de 40 pontos; **48,6%** das contas pontuam abaixo de 40 (o nível que a rubrica rotula como baixo valor ou suspeita de enchimento), enquanto apenas **3,7%** ultrapassam 90. A faixa mais populosa é a de 0–5, composta por contas sem trabalho original, sem pull requests mesclados e sem atividade sustentada. Mesmo em uma amostra enviesada para desenvolvedores ativos, a maioria dos perfis públicos é rasa.

Para calibração, a conta mediana na amostra profunda tem **27 seguidores, 34 stars no total e 20 PRs mesclados**, com uma idade mediana de conta de sete anos. Métricas relevantes para reputação estão fortemente concentradas na cauda superior: o percentil 90 é 1.275 seguidores e cerca de 5.900 stars; o percentil 99 é 19.000 seguidores e cerca de 100.000 stars.

### 3.2 Prevalência e estrutura do farming

![Distribuição da pontuação oculta de spam](/blog/we-scored-19000-github-accounts/spam-score.svg "Figura 2: Distribuição da pontuação interna de probabilidade de spam de 0–10 (n = 18.934). 77% das contas pontuam exatamente 0.")

A *Figura 2* relata a distribuição da pontuação interna de probabilidade de spam entre as 18.934 contas para as quais ela foi computada:

- **77%** das contas pontuam exatamente 0 — nenhum sinal de farming de qualquer tipo.
- **0,58%** (110 contas) pontuam 3 ou mais, o limiar que tratamos como farming claro.
- **12 contas** pontuam 7 ou mais.

A separabilidade das contas de farming deriva não do seu volume, mas da sua *concentração*. Entre os 2.122 desenvolvedores com pelo menos dez pull requests recentes, a proporção mediana de títulos em template é de **7%** — desenvolvedores comuns se repetem modestamente ("fix typo", "bump deps"). Toda conta sinalizada por inundação de templates tem uma proporção acima de **50%**, chegando a **97%**, enquanto o percentil 99 da população completa é 72%. A distribuição é efetivamente bimodal: não há continuidade entre a repetição comum e a geração em lote. Detectar essas contas não exige nenhum modelo treinado — apenas agregação sobre mais de um pull request por conta.

### 3.3 Pull requests triviais são normais; farming de PRs triviais não é

Dos 2.558 desenvolvedores com uma amostra recente de PRs mesclados, **58%** têm pelo menos um PR externo trivial conforme definido na Seção 2.1. Pequenas correções de documentação e typos em repositórios proeminentes são, evidentemente, parte rotineira da participação em open source, inclusive para contribuidores fortes em tudo o mais.

Em contraste, desenvolvedores cujos PRs mesclados recentes são *majoritariamente* triviais, com pelo menos dez PRs assim, constituem **0,4%** da amostra (11 contas).

A distância entre esses dois números tem consequências diretas de design para ferramentas antiabuso. Qualquer heurística que penalize pull requests pequenos por si só penaliza os 58% — novatos, contribuidores de documentação e ajudantes ocasionais — para pegar onze contas cujo comportamento já era conspícuo no nível de padrão. Concluímos que o farming é uma **propriedade de padrão** do histórico de contribuições de uma conta (concentração, uso de templates, repetição contra um único alvo), e não uma **propriedade de evento** de qualquer diff individual, e que detectores operando sobre eventos isolados medem a grandeza errada.

Um resultado paralelo vale para taxas de rejeição. Entre os 2.003 desenvolvedores com pelo menos dez PRs decididos, a taxa mediana de rejeição por mantenedores é de **2%**, com um percentil 90 de 13%. A taxa de aceitação, portanto, carrega pouco sinal discriminativo — condicional a ter PRs mesclados, quase tudo que esses contribuidores submetem é mesclado — e apenas taxas de rejeição extremas (a rubrica sinaliza acima de 50%) são informativas.

### 3.4 Composição dos sinais de alerta: ausência domina manipulação

Rodando novamente o motor atual sobre todas as 3.444 contas da amostra profunda, **17%** disparam pelo menos um sinal de alerta. A *Figura 3* mostra a composição.

![Prevalência dos sinais de alerta](/blog/we-scored-19000-github-accounts/red-flags.svg "Figura 3: Prevalência dos sinais de alerta na amostra profunda (n = 3.444). Sinais do tipo ausência excedem os do tipo manipulação por uma ordem de magnitude.")

Os três sinais mais prevalentes — `ghost_profile` (10%), `no_original_work` (8,2%) e `mostly_forks` (7,2%) — descrevem ausência de substância, não manipulação. Sinais de engano ativo são uma ordem de magnitude mais raros: `templated_pr_flooding` em 0,5%, `trivial_pr_farming` em 0,3%, `follow_farming` em 0,1%. Inflação de stars — contagens altas de stars com forks e issues perto de zero — arredonda para zero nesta amostra, embora a autosseleção plausivelmente a suprima: contas com stars compradas dificilmente se submetem para pontuação.

Para ferramentas de confiança construídas sobre dados do GitHub, essa composição implica dois modos de falha qualitativamente diferentes, exigindo detectores diferentes e tolerâncias de erro diferentes: o caso frequente e barato ("não há nada aqui") e o caso raro e caro ("algo aqui foi fabricado").

### 3.5 Idade da conta como sinal infalsificável

![Pontuação mediana por idade da conta](/blog/we-scored-19000-github-accounts/age-vs-score.svg "Figura 4: Pontuação final mediana por idade da conta. A relação é monotônica em todas as faixas de idade.")

A pontuação mediana cresce monotonicamente com a idade da conta, de **18 pontos para contas com menos de um ano a 86 para contas além do décimo ano**, sem nenhum declínio intermediário (*Figura 4*). A sobrevivência contribui para essa relação — contas antigas que aparecem na amostra são contas antigas ainda em uso — mas a direção do efeito é, em si, informativa. Cada componente da consistência de longo prazo (anos de atividade, repositórios envelhecidos com stars acumuladas organicamente, históricos de contribuição atravessando muitas releases) é precisamente o que a fabricação não consegue comprimir: stars e seguidores podem ser adquiridos em horas, enquanto uma conta de 2015 com nove anos de atividade não pode ser cunhada em 2026. Essa assimetria justifica o peso que a rubrica dá à maturidade da conta e ao intervalo de atividade, e é consistente com nossa observação de que contas sinalizadas por inundação se aglomeram entre contas jovens.

Como observação secundária, a composição de linguagem primária das contas de alta pontuação (pontuação final ≥ 60) segue tendências familiares do ecossistema: **TypeScript (520), Python (460) e JavaScript (395)** lideram, com Rust (225) à frente de Go (189), C (184) e Java (159) (*Figura 5*).

![Linguagens dos que pontuam alto](/blog/we-scored-19000-github-accounts/languages.svg "Figura 5: Linguagens primárias entre contas pontuando 60 ou mais.")

## 4. Discussão

Três princípios de design para ferramentas de integridade de contribuições decorrem dos resultados.

**Detecte padrões, não eventos.** A separação bimodal na Seção 3.2 e a distância de 58% versus 0,4% na Seção 3.3 indicam que contribuições individuais carregam quase nenhum sinal de fabricação, enquanto agregados em nível de conta se separam de forma limpa. Heurísticas de evento único maximizam falsos positivos exatamente contra os contribuidores — novatos e ajudantes de baixo volume — que os projetos open source mais precisam reter.

**Distinga ausência de manipulação.** A maioria das contas que falham em verificações de integridade é vazia, não adversarial (Seção 3.4). Confundir as duas coisas infla as taxas aparentes de fraude e desperdiça esforço de revisão.

**Dê peso ao tempo.** A consistência longitudinal é o único sinal examinado cujo custo de aquisição não pode ser reduzido com dinheiro (Seção 3.5), o que a torna a âncora natural de qualquer pontuação de credibilidade.

Guiados por esses princípios, estamos construindo um GitHub App para ajudar mantenedores na triagem de pull requests de spam, combinando atributos em nível de PR (tamanho do diff, similaridade de template) com o histórico em nível de autor. Dado o risco de falso positivo documentado na Seção 3.3, a ferramenta não fechará pull requests automaticamente; ela apresenta evidências para decisão humana. Convidamos mantenedores de repositórios afetados a compartilhar exemplos do spam que recebem.

## 5. Limitações

- **Amostra autosselecionada.** Usuários do site mais membros de organizações open source ativas tendem a ser genuínos e ativos. As taxas de fabricação no GitHub como um todo são plausivelmente mais altas do que as relatadas aqui; nossas porcentagens são limites inferiores dentro de uma população filtrada.
- **Escala.** 18.947 contas pontuadas, 3.444 com métricas profundas. Os formatos das distribuições são estáveis entre reexecuções, mas a amostra não é representativa do GitHub como um todo.
- **Apenas relato agregado.** Todos os padrões são relatados em agregado; nenhuma conta individual é identificada. Os limiares dos sinais são publicados para que mantenedores possam aplicá-los com contexto.
- **Versionamento do motor.** A prevalência dos sinais de alerta foi recomputada com o pontuador atual sobre o snapshot bruto mais recente de cada conta; as pontuações de spam armazenadas refletem a versão do motor no momento da varredura. Ambas estão incluídas nos [agregados publicados](/blog/we-scored-19000-github-accounts/data.json).

## 6. Reprodutibilidade

Toda a lógica de pontuação é determinística e open source (AGPL) em [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind). O motor idêntico é distribuído via `npm install ghfind` e `pip install ghfind`, e pode ser executado tanto contra a API pública ([especificação OpenAPI](https://ghfind.com/openapi.json)) quanto totalmente local, com um token do GitHub fornecido pelo usuário. As estatísticas agregadas por trás de cada figura deste artigo estão disponíveis como [data.json](/blog/we-scored-19000-github-accounts/data.json).

*Contas individuais podem ser pontuadas em [ghfind.com](https://ghfind.com).*
