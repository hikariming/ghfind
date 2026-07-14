---
title: "Como pontuamos uma conta do GitHub, em bom português"
description: "Um passeio sem jargão pelo motor open source por trás do ghfind: as seis coisas que ele mede, por que pull requests mesclados valem muito mais do que stars, os padrões de bot que ele penaliza e como rodar o pontuador inteiro você mesmo."
date: "2026-07-13"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**Em uma frase:** a pontuação responde a uma única pergunta prática — *esta conta do GitHub é de um desenvolvedor real e valioso, ou é algo inflado para parecer um?* — e responde da mesma forma todas as vezes, usando apenas dados públicos, com todas as regras publicadas abertamente. Este post explica, sem jargão, exatamente como o número é construído.

## Por que uma pontuação, afinal

Cada vez mais decisões dependem de uma olhada no GitHub de alguém. Um recrutador passa os olhos por um perfil antes de uma ligação. Um mantenedor decide se o pull request de um desconhecido vale a revisão. Um diretório ranqueia contas pelo quão impressionantes elas parecem. Cada um desses usos cria um motivo para *falsificar* os sinais — e falsificar os baratos é fácil. Stars podem ser compradas. Seguidores podem ser trocados. Você pode abrir cem pull requests de uma linha em uma tarde e se autodenominar "contribuidor open source".

Então uma pontuação útil não pode simplesmente somar os números grandes e reluzentes. Ela precisa se apoiar nas coisas que são genuinamente difíceis de falsificar e ignorar as que não são. Essa única ideia guia todas as decisões de design abaixo.

## O princípio único: dar peso ao que é difícil de falsificar

Divida cada sinal do GitHub em dois baldes.

- **Barato de falsificar:** stars, seguidores. Alguns dólares ou um esquema de segue-que-eu-sigo os produzem.
- **Caro de falsificar:** pull requests mesclados em projetos reais que *outra pessoa* mantém, anos de atividade constante, código que um mantenedor ocupado de fato aceitou.

O motor dá muito peso ao segundo balde e pouco ao primeiro. Stars e seguidores ainda contam — um projeto genuinamente popular *deve* ajudar você — mas têm um teto baixo o suficiente para que comprá-los mal mova o ponteiro. Enquanto isso, ter código real mesclado em um repositório conhecido, o que exige convencer um humano que não tem motivo nenhum para ajudar você, vale o maior número de pontos do placar.

Essa é toda a filosofia. O resto é só como ela se distribui por seis categorias.

## As seis coisas que ele mede

A pontuação vai de 0 a 100, dividida em seis dimensões. Aqui está cada uma em termos simples, com sua pontuação máxima.

| Dimensão | Máx | O que ela realmente pergunta |
|---|---|---|
| **Qualidade das contribuições** | 27 | Você tem pull requests reais mesclados em projetos reais, e os mantenedores os aceitam? |
| **Impacto no ecossistema** | 20 | Seu código chegou a repositórios genuinamente populares — que não são seus? |
| **Qualidade dos projetos originais** | 18 | Você construiu algo que as pessoas realmente usam (medido por stars, mas com teto)? |
| **Autenticidade da atividade** | 17 | Você é ativo de forma constante ao longo do tempo, de maneiras variadas — ou foi um surto e depois silêncio? |
| **Maturidade da conta** | 10 | Há quanto tempo esta conta existe e se mantém ativa? |
| **Influência na comunidade** | 8 | Você tem seguidores de verdade, com uma proporção saudável? |

![Para onde vão os 100 pontos, por dimensão](/blog/how-we-score-github-accounts/weight-breakdown.svg "As seis dimensões e suas pontuações máximas. Laranja = sinais difíceis de falsificar; cinza = os compráveis.")

Repare que as duas maiores fatias — qualidade das contribuições (27) e impacto no ecossistema (20) — são exatamente as difíceis de falsificar. Stars (18) e seguidores (8), os compráveis, juntos valem menos do que pull requests mesclados sozinhos. Essa ordem é o ponto central.

### O sinal que mais importa: código de quem, no repositório de quem

O número mais importante de todos é o **impacto no ecossistema** (20 pontos), e vale a pena explicar por quê, porque é a parte mais engenhosa.

Ele conta pull requests substanciais — mais de cinco linhas, nada de correções de typo — que foram mesclados em **repositórios populares que não pertencem a você**. Pense em um desenvolvedor cujo trabalho de verdade vive dentro do código de um projeto famoso, e não nos próprios repositórios estrelados. Isso não dá para falsificar. Mesclar uma mudança real em um projeto de 50.000 stars significa que um mantenedor sem nenhum incentivo para ajudar você olhou para o seu código e disse sim. É a coisa mais próxima de uma credencial revisada por pares que o GitHub tem.

Há uma exceção deliberada. Se o repositório popular é *seu* — mas genuinamente popular, com 1.000 stars ou mais — isso ainda conta, porque captura o criador que passa o tempo construindo o próprio projeto famoso em vez de contribuir para os dos outros. O que **não** conta são pull requests nos seus próprios repositórios minúsculos. Abrir PRs contra um projeto que você criou ontem e que ninguém estrela é a forma clássica de inflar uma contagem de contribuições, então eles são excluídos aqui (e penalizados em outro lugar).

## Por que números grandes não dominam tudo

Uma pontuação ingênua deixaria um repositório viral, ou uma conta com 100.000 seguidores, dominar tudo. Esta não deixa, e o motivo é uma única decisão de design: todo número de "quanto" passa por uma **curva de retornos decrescentes** antes de virar pontos.

![Curva de retornos decrescentes: pontos ganhos vs. stars](/blog/how-we-score-github-accounts/diminishing-returns.svg "Os pontos sobem rápido até alguns milhares de stars e depois se achatam — assim um mega-repositório ou stars compradas não dominam.")

Em termos simples: ir de 0 a 1.000 stars rende muitos pontos. Ir de 50.000 a 51.000 rende quase nada — você já estava perto do topo. A curva recompensa quem passa de uma barra significativa sem deixar que meia dúzia de mega-números sufoque todo o resto. Um desenvolvedor sólido com alguns milhares de stars e um histórico constante não fica soterrado pelo único repositório viral de outra pessoa. Também significa que comprar stars tem valor fortemente decrescente: as primeiras stars compradas fazem pouco, e subir a curva na base da compra fica caro rapidamente, com retorno quase nulo.

## Os sinais de alerta: pegando os falsos

Além das seis dimensões positivas, o motor subtrai pontos por padrões específicos e bem conhecidos de trapaça e baixo esforço. São as assinaturas de bots, spam e contas fabricadas. Alguns dos principais, em linguagem simples:

- **Inundação de PRs com template** — dezenas de pull requests quase idênticos, gerados automaticamente, geralmente mirando o mesmo repositório. É o sinal mais forte de um histórico de contribuições fabricado.
- **Fazenda de PRs triviais** — uma pilha de pull requests de uma linha do tipo "fix typo" engordando uma contagem de contribuições sem trabalho real.
- **Fazenda de auto-PRs** — abrir e mesclar os próprios pull requests nos próprios repositórios sem stars para inflar os números. Mesclar o próprio código não prova nada.
- **Fazenda de seguidores** — seguir milhares de contas para pescar follow-backs, deixando uma proporção seguidor/seguindo desequilibrada.
- **Repositórios em massa em uma conta novíssima** — uma conta criada mês passado com cinquenta repositórios quase nunca é um desenvolvedor real.
- **Perfil fantasma** — sem bio, quase sem seguidores, sem stars, quase nenhum trabalho mesclado. Não é malicioso, só vazio.
- **Possível inflação de stars** — um repositório com muitas stars mas quase nenhum fork ou issue, que é exatamente a cara de stars compradas.

As penalidades se acumulam, até um limite, de modo que uma conta que tropeça em várias delas termina perto do fundo, não importa quão bons pareçam seus números brutos. Crucialmente, esses padrões vivem no nível do *histórico* de uma conta, não de uma ação isolada — um único PR de uma linha é completamente normal; uma centena deles mirando um só repositório, não.

## O que o número final significa

Some as seis dimensões, subtraia os sinais de alerta, e você cai em um de quatro níveis:

| Pontuação | Nível | Significado |
|---|---|---|
| 90–100 | **夯 (Sólido)** | Desenvolvedor de primeira linha — alto valor, alta confiança. |
| 70–89 | **人上人 (Destaque)** | Contribuidor de qualidade — merece confiança. |
| 40–69 | **NPC** | Conta comum — sinais medianos ou pouco claros. |
| 0–39 | **拉完了 (Acabado)** | Baixo valor — provavelmente inativa, vazia ou fabricada. |

Os nomes dos níveis são deliberadamente um pouco brincalhões — isto começou como uma ferramenta de zoação — mas as faixas por trás deles são a mesma matemática determinística para todo mundo.

## Uma nota honesta sobre o que a pontuação *não* é

- **Ela só vê atividade pública.** Alguém que faz um trabalho excelente em um repositório privado da empresa pode parecer raso aqui. Uma pontuação baixa é uma afirmação sobre a pegada *pública*, não um veredito sobre a pessoa.
- **É um ponto de partida, não um juiz.** O número existe para ajudar um humano a priorizar — qual PR de desconhecido olhar primeiro, qual perfil merece uma leitura mais atenta — não para rejeitar ninguém automaticamente. As evidências por trás da pontuação importam mais do que a pontuação.
- **Comportamento recente conta mais do que história antiga.** O sinal de impacto no ecossistema olha para pull requests recentes, então alguém cujas grandes contribuições foram todas anos atrás vai pontuar menos do que o currículo sugere. Isso é intencional: ele mede o que você está fazendo *agora*.

## É open source — rode você mesmo

Nada disso é uma caixa-preta, e esse é o ponto. Não há modelo no circuito, nem pesos escondidos, nem "confie na gente". A mesma entrada sempre produz a mesma pontuação, e cada regra descrita acima — cada peso, cada limiar, cada gatilho de alerta — está publicada sob a licença AGPL.

- **Leia o código:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind)
- **Instale o motor:** `npm install ghfind` ou `pip install ghfind`
- **Rode localmente** com seu próprio token do GitHub — nada sai da sua máquina — ou chame a API pública ([especificação OpenAPI](https://ghfind.com/openapi.json)).
- **Pontue uma conta** no navegador em [ghfind.com](https://ghfind.com).

Se você discorda de um peso ou de um limiar, pode ler exatamente qual ele é, mudá-lo e ver o efeito. Uma pontuação de confiança que as pessoas não podem inspecionar não vale muita coisa — então fizemos uma que você pode.
