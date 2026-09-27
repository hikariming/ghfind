---
title: "Como pontuamos uma conta do GitHub, em bom português"
description: "Um passeio sem jargão pelo devscore, o motor open source por trás do ghfind: por que ele pesa o trabalho real em vez de stars e seguidores, como decide quanto um projeto vale e quanto dele é seu, os padrões de farming que ele coloca no teto e o que significam as seis dimensões de um perfil."
date: "2026-07-13"
updated: "2026-09-28"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**Em uma frase:** a pontuação responde a uma única pergunta prática — *quanto trabalho real e valioso este desenvolvedor fez em público?* — e responde da mesma forma todas as vezes, usando apenas dados públicos, com todas as regras publicadas abertamente. Este post explica, sem jargão, como o número é construído.

## Por que uma pontuação, afinal

Cada vez mais decisões dependem de uma olhada no GitHub de alguém. Um recrutador passa os olhos por um perfil antes de uma ligação. Um mantenedor decide se o pull request de um desconhecido vale a revisão. Um diretório ranqueia contas pelo quão impressionantes elas parecem. Cada um desses usos cria um motivo para *falsificar* os sinais — e os sinais populares são os mais fáceis de falsificar. Stars podem ser compradas. Seguidores podem ser trocados. Você pode abrir cem pull requests de uma linha em uma tarde e se autodenominar "contribuidor open source".

Então uma pontuação útil não pode somar os números grandes e reluzentes. Ela precisa medir o próprio trabalho e ignorar os números que podem ser comprados. Essa única ideia guia todas as decisões de design abaixo.

## O princípio único: pesar o trabalho, não os aplausos

O motor por trás da pontuação se chama **devscore**. A regra dele é curta: *pontuar o que um desenvolvedor realmente construiu, ponderado por quanto aquilo importa e por quanto daquilo é dele.*

- **Stars e seguidores nunca contam.** Nem um pouco, nem com teto — zero. Eles medem atenção, e atenção é barata de comprar.
- **Contagem de pull requests também não conta.** O motor mede os commits que você escreveu e o que eles mudaram, então cem PRs de uma linha continuam sendo cem mudanças de uma linha.
- **O que conta é código que entrou em projetos que as pessoas usam.** Seus próprios projetos contam quando outras pessoas os usam; seu trabalho em projetos de outras pessoas conta quando um mantenedor independente o aceitou.

## Quanto vale um projeto

Para cada repositório, o devscore primeiro pergunta o quanto o projeto importa. Ele nunca olha para stars. Ele olha para sinais difíceis de falsificar, porque exigem que outras pessoas *façam* alguma coisa:

- **outros contribuidores** que escreveram código nele,
- **dependentes downstream** — pacotes que dependem dele,
- **autores de issues de fora** — pessoas que o usam o bastante para reportar problemas,
- **forks**, com desconto, porque são o mais barato desses sinais para farmar.

Cada salto de dez vezes na adoção soma a mesma quantidade, então um kernel com milhares de contribuidores fica bem acima de uma biblioteca com vinte, enquanto um projeto usado só pelo autor e alguns amigos fica perto do piso. Um projeto que ninguém mais usa fica com só uma pequena parte do trabalho feito nele — construir algo para si mesmo é ótimo, mas ainda não é algo de que outras pessoas dependem.

Projetos que são só stars e nenhum usuário recebem tratamento especial. Um **projeto de hype** — muitas stars, mas quase nenhum contribuidor, autor de issue ou dependente, ou um pico promocional repentino seguido de silêncio — não ganha crédito de projeto nenhum.

## Quanto dele é seu

Em seguida, o devscore pergunta quanto do trabalho daquele projeto é seu. Ele combina sua fatia dos commits com sua posição em relação ao autor principal, de modo que um co-líder de um projeto grande conta como autor mesmo com uma fatia modesta, enquanto um contribuidor distante atrás de um líder dominante não conta. Milhares de commits seus contam como autoria, qualquer que seja o tamanho do projeto.

Depois ele mede o próprio trabalho: quantos commits você emplacou, o que eles mudaram (código central conta mais do que docs ou tarefas de manutenção; uma mudança grande que um mantenedor aceitou conta mais do que uma minúscula) e por quantos meses o trabalho durou. Históricos de commits que parecem gerados por máquina — todo commit na mesma hora, toda mudança com o mesmo formato — são descontados.

## Projetos de outras pessoas: só conta o trabalho aceito

Trabalho no repositório de outra pessoa é a coisa mais próxima de uma revisão por pares que o GitHub tem — mas só se alguém independente de fato revisou. Por isso o devscore conta trabalho externo **só na medida em que um mantenedor independente o aceitou**:

- um PR mesclado pelo autor principal do projeto conta inteiro;
- um que foi aprovado por alguém que não escreveu nada do código conta metade;
- um PR que você mesmo mesclou, ou que foi mesclado por um parceiro de troca que mescla os seus em retribuição, não conta nada;
- dezenas de PRs grandes e isolados mesclados em lote durante uma campanha de recompensas são descontados.

Revisar e mesclar código de outras pessoas também é trabalho real. Um **mantenedor** — verificado pelo próprio registro do GitHub sobre o seu papel naquele repositório, nunca autodeclarado — recebe crédito por esse trabalho, e os code reviews que você faz em projetos de outras pessoas também contam.

## Tempo: anos sustentados, não surtos

Por fim, o devscore recompensa fazer isso por anos. Ele conta **anos sustentados de programação**: cada ano-calendário conta uma vez, com teto de doze meses de programação, então espalhar um ano por sessenta repositórios pequenos continua sendo um ano. Trabalho mais antigo vai perdendo peso com meia-vida de três anos (até um piso, então uma carreira longa nunca é apagada).

Tudo isso é combinado em uma única curva suave de 0 a 100, com espaço no topo para que os melhores de todos se separem em vez de empatar em 100. O papel mais forte vence: alguém é avaliado tanto como desenvolvedor quanto como mantenedor, e conta o melhor dos dois.

## Pegando os falsos

A maior parte do farming nem precisa de penalidade, porque os sinais que ele produz — stars, seguidores, contagem de PRs, auto-merges — já não valem nada. Dois padrões recebem um **teto** explícito, aplicado por último:

- **PRs em massa de baixa qualidade.** Nos piores doze meses, muitos PRs em projetos de outras pessoas foram rejeitados ou retirados — pelo menos tantos quanto os que foram mesclados de forma independente — junto com pelo menos dois destes: títulos saídos de template, envios duplicados, maratonas de uma semana em vários repositórios ou PRs gigantes de milhares de linhas.
- **O padrão de influencer.** Centenas de seguidores, muito desproporcionais à engenharia que outras pessoas aceitaram, sem nenhum projeto mantido e sem nenhum projeto próprio substancial.

Uma pontuação com teto é espremida na faixa de 20–35, ainda ordenada pelo trabalho subjacente. Crucialmente, os dois tetos disparam em um *padrão* ao longo de um histórico — um único PR rejeitado, ou uma conta popular que também entrega código de verdade, é completamente normal.

## Os seis números de um perfil

O total é a pontuação do devscore. Para deixá-la legível, cada perfil também mostra seis **dimensões de exibição** derivadas dos fatores do devscore. Elas explicam a pontuação; não são somadas para formá-la.

| Dimensão | Máx | O que ela mostra |
|---|---|---|
| **Qualidade das contribuições** | 27 | Trabalho aceito de forma independente em projetos de outras pessoas, mais os code reviews que você faz lá |
| **Impacto no ecossistema** | 20 | O peso do seu trabalho entre repositórios, ou um papel de mantenedor verificado — o que for maior |
| **Qualidade de projetos originais** | 18 | Seu projeto principal: o projeto de engenharia mais forte que você possui ou lidera |
| **Autenticidade da atividade** | 17 | Quanto do seu trabalho é recente; cai bruscamente quando um teto de farming se aplica |
| **Maturidade da conta** | 10 | Anos sustentados de programação |
| **Influência na comunidade** | 8 | Com que frequência mantenedores mesclam em vez de rejeitar seus PRs, mais reviews feitos — nunca seguidores |

## O que o número final significa

| Pontuação | Nível | Significado |
|---|---|---|
| 90–100 | **夯 (Lendário)** | Lendário — trabalho de hall da fama. |
| 80–89 | **顶级 (Elite)** | Desenvolvedor de primeira linha. |
| 70–79 | **人上人 (Sólido)** | Contribuidor de qualidade — merece confiança. |
| 40–69 | **NPC** | Conta comum — sinais medianos ou pouco claros. |
| 0–39 | **拉完了 (Acabado)** | Pouco trabalho público — ou um padrão de farming com teto. |

Os nomes dos níveis são deliberadamente um pouco brincalhões — isto começou como uma ferramenta de zoação — mas a matemática por trás deles é a mesma para todo mundo.

## Uma nota honesta sobre o que a pontuação *não* é

- **Ela só vê atividade pública.** Alguém que faz um trabalho excelente em repositórios privados da empresa pode parecer raso aqui. Uma pontuação baixa é uma afirmação sobre a pegada *pública*, não um veredito sobre a pessoa. Cada pontuação traz um nível de confiança que diz em quanta evidência pública ela se apoia.
- **É um ponto de partida, não um juiz.** O número existe para ajudar um humano a priorizar — qual PR de desconhecido olhar primeiro, qual perfil merece uma leitura mais atenta — não para rejeitar ninguém automaticamente. As evidências por trás da pontuação importam mais do que a pontuação.
- **Trabalho antigo perde peso, devagar.** Anos recentes contam mais do que história antiga, mas um histórico longo nunca é apagado.

## É open source — rode você mesmo

Nada disso é uma caixa-preta. Não há modelo no circuito nem pesos escondidos: os mesmos dados públicos sempre produzem a mesma pontuação, e cada regra descrita acima — cada peso, cada limiar, cada teto — está publicada sob a licença AGPL.

- **Leia o código:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind) (o motor fica em `src/lib/devscore`)
- **Rode localmente** com `npx @hikariming/ghfind score <user> --local` e seu próprio token do GitHub — nada sai da sua máquina — ou chame a API pública ([especificação OpenAPI](https://ghfind.com/openapi.json)).
- **Pontue uma conta** no navegador em [ghfind.com](https://ghfind.com).

Se você discorda de um peso ou de um limiar, pode ler exatamente qual ele é, mudá-lo e ver o efeito. Uma pontuação de confiança que as pessoas não podem inspecionar não vale muita coisa — então fizemos uma que você pode.
