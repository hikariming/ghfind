---
title: "382.000 stars, um único par de mãos: quem realmente constrói o OpenClaw?"
description: "O OpenClaw se tornou o repositório de crescimento mais rápido da história do GitHub. Pontuamos seus 100 maiores contribuidores com um motor determinístico: uma pessoa escreveu 57% dos commits, zero contribuidores mostram sinais de atividade falsificada, e um quinto deles entrou no GitHub há menos de um ano."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Principais achados** (dados coletados em 2026-07-11, os 100 maiores committers de [openclaw/openclaw](https://github.com/openclaw/openclaw), pontuados com o [motor ghfind](/methodology) open source):

- **O repositório de crescimento mais rápido da história do GitHub é, medido em commits, majoritariamente uma pessoa.** O criador [steipete](/u/steipete) escreveu 33.482 dos 58.487 commits da amostra — **57,2%**. Os três primeiros contribuidores respondem por 81,5%, os dez primeiros por 90,2%.
- **Zero atividade falsificada.** Nenhum dos 96 humanos do top 100 mostra o padrão de contribuição fabricada que nosso motor sinaliza — um padrão que aparece em 0,58% das contas mesmo na nossa linha de base cuidadosamente filtrada de 18.947 contas. O hype é enorme; as pessoas por trás dele são reais.
- **O boom dos agentes de IA está puxando novatos para o open source.** 19,6% dos maiores contribuidores têm contas no GitHub com menos de um ano (no Dify, um projeto mais antigo de fama comparável, são 4,7%). Alguns já são excelentes: o committer nº 3 tem uma conta de 2,3 anos que pontua 94,1.

## Por que o OpenClaw

O [OpenClaw](https://github.com/openclaw/openclaw) dispensa apresentações: criado em 2025-11-24 por Peter Steinberger ([steipete](/u/steipete), fundador da PSPDFKit), renomeado duas vezes em uma única semana de janeiro de 2026 (Clawdbot → Moltbot → OpenClaw), e o projeto mais rápido da história a alcançar 100.000 stars no GitHub. Em 2026-07-11 ele soma **382.580 stars, 80.292 forks e 368 contribuidores de código** — cerca de sete meses e meio após o primeiro commit.

Uma curva de stars assim é exatamente para o que nosso motor foi construído: quando um número sobe tão rápido, existe algo real por baixo? Pegamos os 100 maiores contribuidores por número de commits, excluímos 4 bots (incluindo o `clawsweeper` e o `openclaw-clownfish` do próprio projeto) e pontuamos todos os 96 humanos. 92 têm snapshots completos de métricas brutas.

## Qualidade dos contribuidores: o topo da lista é excelente

| | OpenClaw top-100 | Dify top-100 | Linha de base 19k |
|---|---|---|---|
| Pontuação mediana | **79,7** | 78,2 | 42,5 |
| Pontuação ≥ 90 (nível 夯) | **21,9%** | 15,6% | 3,7% |
| Pontuação ≥ 70 (confiável) | **69,8%** | 70,8% | 20,1% |
| Pontuação < 40 (baixo valor) | **9,4%** | 5,2% | 48,6% |

(A coluna do Dify vem do [nosso estudo companheiro](/blog/who-builds-dify), pontuado na mesma semana com o mesmo motor.)

Um em cada cinco dos maiores contribuidores do OpenClaw pontua 90 ou mais; no GitHub como um todo, apenas cerca de uma conta em vinte e sete consegue. Quando um projeto tem a atenção da indústria inteira, desenvolvedores excelentes aparecem para construí-lo. Mas olhe também para a outra ponta: 9,4% pontuam abaixo de 40, quase o dobro da taxa do Dify. Toda essa atenção também atrai contas novíssimas com quase nada nelas — a seção sobre idades das contas, abaixo, explica de onde elas vêm.

## Um único par de mãos

Total de commits na amostra top-100: 58.487 — sete vezes os 8.434 do Dify, produzidos em um quinto do tempo de calendário.

| Fatia dos commits | OpenClaw | Dify |
|---|---|---|
| Contribuidor mais ativo | **57,2%** | 8,4% |
| Top 3 | **81,5%** | 21,0% |
| Top 5 | **86,0%** | 31,3% |
| Top 10 | **90,2%** | 49,8% |

Os 33.482 commits de [steipete](/u/steipete) ao longo de 229 dias dão **146 commits por dia**. Ninguém digita tão rápido — mas alguém dirigindo uma frota de agentes de código e revisando o que eles produzem consegue mesclar nessa velocidade, e é exatamente assim que o OpenClaw é notoriamente construído. O motor dá à conta um **100/100**: um histórico de 17 anos no GitHub, 52.067 seguidores, 2.772 PRs mesclados — o mais longe possível de uma conta falsa. A produção é real. Ela está simplesmente concentrada em um único par de mãos em um grau que nenhum projeto deste tamanho jamais mostrou.

O escalão seguinte é pequeno mas sério: [vincentkoc](/u/vincentkoc) (10.502 commits, pontuação 96,5), [shakkernerd](/u/shakkernerd) (3.688, pontuação 94,1), [obviyus](/u/obviyus) (1.771, pontuação 93,2). Abaixo da décima posição, ninguém responde nem por meio por cento dos commits.

Os dois jeitos de construir funcionam: o Dify é escrito por uma comunidade genuinamente ampla; o OpenClaw é uma pessoa tomando todas as decisões e andando mais rápido do que qualquer projeto antes dele. Mas os riscos são diferentes — se essa única pessoa parar, tudo para — e uma contagem de stars de 148 mil versus 382 mil não diz nada sobre qual risco você está assumindo.

## Nenhuma atividade falsificada — e por que ainda vale dizer isso

Entre todos os 96 humanos: **zero** contas no limiar do motor para contribuições fabricadas ou acima dele, seja usando as pontuações armazenadas, seja recomputando com o motor atual. Sinais de alerta aparecem em 19 das 92 contas (20,7%), mas todos eles são da variedade "perfil raso" ou "muitos PRs rejeitados" — `mostly_forks` (15), `no_original_work` (10), `high_pr_rejection` (4). Nenhum mostra títulos de PR produzidos em massa; nenhum mostra um histórico engordado com PRs triviais. Para comparação, até o top 100 do Dify contém duas contas assim, e a taxa da linha de base é 0,58%.

Uma ressalva honesta: ranquear por número de commits naturalmente mantém os falsificadores fora desta amostra. A jogada característica deles é um ou dois PRs triviais por repositório, e o contribuidor nº 100 do OpenClaw tem 24 commits — você não chega aqui com correções de typo. Se atividade falsificada existe em torno do OpenClaw, ela vive na cauda longa dos 368 contribuidores e nas [mais de 2.800 identidades de email anônimas](https://github.com/openclaw/openclaw/graphs/contributors) além deles, que este estudo não cobre. O que o resultado descarta é uma acusação mais séria: a de que os números espantosos do OpenClaw foram sustentados por um exército de contas falsas. Não foram. As pessoas no topo deste projeto passam na verificação, uma por uma.

## A onda de novatos

Idade das contas é onde o OpenClaw deixa de se parecer com o Dify por completo:

| | OpenClaw | Dify |
|---|---|---|
| Contas < 1 ano | **19,6%** | 4,7% |
| Contas < 2 anos | **26,1%** | 9,3% |
| Idade mediana da conta | 8,7 anos | 9,0 anos |

Os contribuidores se dividem em dois grupos distintos: um núcleo veterano que entrou no GitHub por volta de 2017, e um quinto cujas contas mal existiam um ano atrás. Esses novatos foram puxados para o open source pelo boom dos agentes de IA — e não estão só de passagem. O destaque é [shakkernerd](/u/shakkernerd): uma conta de 2,3 anos, 362 seguidores, e a posição nº 3 em commits no maior repositório do ano, pontuando 94,1. Os que pontuam baixo (9,4% abaixo de 40 pontos) são o outro lado da mesma onda: contas novíssimas cuja primeira atividade open source da vida é uma pequena correção no OpenClaw. Daqui a um ano, elas terão construído históricos reais ou terão silenciado — vamos rodar os números de novo e descobrir.

## Os cinco subestimados

Pontuações de primeira linha, seguidores escassos — os frequentadores do OpenClaw que ninguém está olhando:

| Contribuidor | Pontuação | Nível | Seguidores | Commits aqui |
|---|---|---|---|---|
| [RomneyDa](/u/RomneyDa) | 98,4 | 夯 | 169 | 290 |
| [altaywtf](/u/altaywtf) | 97,7 | 夯 | 273 | 66 |
| [osolmaz](/u/osolmaz) | 97,2 | 夯 | 290 | 76 |
| [ngutman](/u/ngutman) | 96,0 | 夯 | 91 | 143 |
| [omarshahine](/u/omarshahine) | 93,4 | 夯 | 60 | 57 |

Menção especial a [joshavant](/u/joshavant): nº 7 em commits (558), pontuação 95,7, 160 seguidores. A distância entre o que as pessoas contribuem e quantas pessoas as acompanham é o tema recorrente desta série — quem faz o trabalho raramente é quem é seguido.

## Método e limitações

As pontuações vêm da rubrica determinística do ghfind — seis dimensões sobre dados públicos do GitHub, sem chamadas a modelos, open source sob AGPL. Rubrica completa e limiares: [metodologia](/methodology). Os agregados por trás de cada tabela: [data.json](/blog/who-builds-openclaw/data.json).

- **Top-100 por commits é a cabeça do projeto, não a comunidade inteira.** O OpenClaw conta 368 contribuidores de código mais ~2.800 identidades de email anônimas; se atividade falsificada existe, ela estaria nessa cauda, que não pontuamos.
- **Contagens brutas de commits dependem do fluxo de trabalho.** O estilo do OpenClaw, dirigido por agentes e com commits diretos, produz muito mais commits para a mesma quantidade de trabalho do que um projeto de squash-and-merge como o Dify. Percentuais dentro de um mesmo repositório são significativos; comparar totais brutos de commits entre repositórios, não.
- **Isto é um snapshot.** Dados coletados em 2026-07-11, sobre um projeto que se move mais rápido do que qualquer outro antes dele. Dados ao vivo: [página do projeto OpenClaw](/developers/repo/openclaw/openclaw).
- **Achados sobre atividade falsa são relatados apenas em agregado.** Só nomeamos indivíduos quando a notícia é boa.

---

*Navegue pelo [painel ao vivo de contribuidores do OpenClaw](/developers/repo/openclaw/openclaw), leia o [estudo companheiro sobre o Dify](/blog/who-builds-dify), ou [pontue sua própria conta do GitHub](/) — mesmo motor, 20 segundos.*
