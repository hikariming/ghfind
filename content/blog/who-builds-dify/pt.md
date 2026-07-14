---
title: "Quem constrói o Dify? Pontuamos seus 100 maiores contribuidores"
description: "O Dify tem 148.500 stars e 458 contribuidores de código. Passamos seus 100 maiores committers por um motor de pontuação determinístico: mediana de 78 contra uma linha de base global de 42,5, 71% se classificam como contribuidores confiáveis, e o trabalho está distribuído entre muito mais gente do que o habitual."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Principais achados** (dados coletados em 2026-07-11, os 100 maiores committers de [langgenius/dify](https://github.com/langgenius/dify), pontuados com o [motor ghfind](/methodology) open source):

- **Os 100 maiores contribuidores do Dify têm pontuação mediana de 78,2 / 100 — 36 pontos acima da mediana de 42,5 da nossa linha de base de 18.947 contas.** 70,8% passam da barra de "contribuidor confiável" (pontuação ≥ 70) que apenas 20,1% da população geral alcança.
- **Eles parecem desenvolvedores comuns até você olhar a produção deles.** Mediana de seguidores: 31 (linha de base: 27). Mediana de pull requests mesclados: 118 (linha de base: 20). O Dify é construído por profissionais discretos mas prolíficos, não por alguém que você reconheceria das redes sociais.
- **Nenhuma pessoa sozinha domina o código — algo raro para um projeto tão famoso.** O committer mais ativo escreveu apenas 8,4% dos commits, os três primeiros escreveram 21%, os dez primeiros pouco menos da metade. Compare com [projetos virais de IA que são majoritariamente o trabalho de uma pessoa](/blog/who-builds-openclaw).

## Por que o Dify

O [Dify](https://github.com/langgenius/dify) é uma das plataformas de aplicações LLM com mais stars no GitHub — 148.500 stars, 458 contribuidores de código, criado em abril de 2023. Contagem de stars é o jeito padrão de julgar a saúde de um projeto, e também é o número mais fácil de inflar. Então fizemos a pergunta que as stars não respondem: **quem de fato escreve isso, e o histórico dessas pessoas se sustenta quando você verifica se é real?**

Pegamos os 100 maiores contribuidores por número de commits, excluímos 3 bots (`dependabot`, `github-actions` e — um sinal dos tempos — `Copilot`) e pontuamos os 97 humanos restantes com nosso motor determinístico. 96 foram resolvidos com sucesso; 86 têm snapshots completos de métricas brutas. O motor é o mesmo por trás de toda pontuação deste site: 100 pontos em seis dimensões, sem chamadas a modelos, entradas idênticas produzem saídas idênticas.

## Qualidade dos contribuidores: muito acima da linha de base

| | Dify top-100 | Linha de base 19k |
|---|---|---|
| Pontuação mediana | **78,2** | 42,5 |
| Pontuação ≥ 90 (nível 夯) | **15,6%** | 3,7% |
| Pontuação ≥ 70 (confiável) | **70,8%** | 20,1% |
| Pontuação < 40 (baixo valor) | **5,2%** | 48,6% |

As duas distribuições mal se sobrepõem. Até o contribuidor do percentil 10 do Dify (56,1) supera a mediana global em 13 pontos. Quinze dos noventa e seis pontuam 90 ou mais — uma barra que só uma conta do GitHub em vinte e sete ultrapassa.

As cinco contas abaixo de 40 também merecem uma nota: todo repositório popular acumula uma cauda de gente que emplacou um commit e tem pouco mais no perfil. Em um projeto saudável, essa cauda é cerca de 5% da lista dos maiores contribuidores. Na população da linha de base, quase metade de todas as contas está abaixo de 40.

## Profissionais discretos

O padrão mais interessante é a distância entre a visibilidade dessas pessoas e o quanto elas produzem:

| Mediana, por contribuidor | Dify top-100 | Linha de base 19k |
|---|---|---|
| Seguidores | 31 | 27 |
| Pull requests mesclados | **118** | 20 |
| Idade da conta | 9,0 anos | 7,4 anos |

Pela contagem de seguidores, os contribuidores centrais do Dify são indistinguíveis da conta média do GitHub. Por pull requests mesclados, eles produzem **seis vezes** a linha de base. É o oposto exato do perfil de atividade falsificada que nosso [estudo de 19 mil contas](/blog/we-scored-19000-github-accounts) documentou — contas fabricadas poliam os números que todo mundo vê e pulam o trabalho de verdade. Os contribuidores do Dify fazem o trabalho e pulam a autopromoção.

As idades das contas contam a mesma história: apenas 4 das 86 contas com dados completos têm menos de um ano. Isto não é uma multidão de contas recém-criadas correndo atrás de um repositório em alta — o contribuidor típico está no GitHub desde 2017.

## Atividade falsa aparece até aqui

Duas contas no top 100 (2,1%) excedem o limiar que nosso motor usa para farming — a prática de fabricar um histórico de contribuições a partir de pull requests repetitivos e de baixo esforço. Na população da linha de base, essa taxa é 0,58%. Rodando novamente o motor atual sobre os snapshots mais recentes, uma das duas é sinalizada (1,2%). Sinais de alerta de qualquer tipo aparecem em 13 das 86 contas (15,1%, linha de base 17%), mas quase todos dizem "este perfil é raso" (`mostly_forks`: 12) em vez de "este perfil é falso": exatamente uma conta mostra títulos de PR produzidos em massa, e uma mostra um histórico construído sobre PRs triviais.

Relatamos isso apenas em agregado, mas o ponto geral se mantém: **ser um projeto famoso não mantém sua lista de top-100 contribuidores limpa.** A popularidade atrai esse comportamento, porque pequenos PRs de template mesclados em um repositório famoso são a linha de currículo mais barata do mercado. É precisamente esse o problema que nossa futura ferramenta para mantenedores foi feita para pegar.

## Construído por muitas mãos

Total de commits na amostra top-100: 8.434.

| Fatia dos commits | |
|---|---|
| Contribuidor mais ativo | 8,4% |
| Top 3 | 21,0% |
| Top 5 | 31,3% |
| Top 10 | 49,8% |

Mais da metade de todos os commits vem de **fora** dos dez primeiros. Projetos famosos de IA normalmente se apoiam em um ou dois mantenedores exaustos, e param de andar quando essas pessoas param; o Dify espalhar o trabalho dessa forma o torna incomumente difícil de quebrar. O topo da tabela mistura funcionários da LangGenius com mantenedores independentes da comunidade, e a queda do nº 1 (708 commits) para o nº 10 (249) é uma rampa suave, não um penhasco.

## Os cinco subestimados

Os contribuidores que nosso motor avalia mais alto e que quase ninguém segue:

| Contribuidor | Pontuação | Nível | Seguidores |
|---|---|---|---|
| [linw1995](/u/linw1995) | 96,4 | 夯 | 165 |
| [kurokobo](/u/kurokobo) | 94,3 | 夯 | 116 |
| [junjiem](/u/junjiem) | 93,8 | 夯 | 229 |
| [lin-snow](/u/lin-snow) | 92,3 | 夯 | 152 |
| [WH-2099](/u/WH-2099) | 89,6 | 顶级 | 31 |

Menção especial a [bowenliang123](/u/bowenliang123) (94,0, nº 8 em commits) e [hjlarry](/u/hjlarry) (93,6, nº 6 em commits): committers do top dez de um dos projetos de IA mais populares do mundo, cada um com menos de 170 seguidores. Se você está contratando, comece por esta tabela — essas pessoas são muito melhores do que suas contagens de seguidores sugerem.

## Método e limitações

As pontuações vêm da rubrica determinística do ghfind — seis dimensões sobre dados públicos do GitHub, sem chamadas a modelos, open source sob AGPL. Rubrica completa e limiares: [metodologia](/methodology). Os agregados por trás de cada tabela: [data.json](/blog/who-builds-dify/data.json).

- **Top-100 por commits não é a comunidade inteira.** O Dify tem 458 contribuidores de código; pontuamos a ponta mais ativa. A cauda longa de contribuidores ocasionais provavelmente pontua menos.
- **Isto é um snapshot.** Dados coletados em 2026-07-11. Stars e commits mudam diariamente; dados ao vivo dos contribuidores estão na [página do projeto Dify](/developers/repo/langgenius/dify).
- **Contagem de commits mede volume, não importância.** A tabela de fatias de commits diz quem mais commitou, não quem escreveu o código do qual todo o resto depende.
- **Achados sobre atividade falsa são relatados apenas em agregado.** Só nomeamos indivíduos quando a notícia é boa.

---

*Navegue pelo [painel ao vivo de contribuidores do Dify](/developers/repo/langgenius/dify), leia o [estudo companheiro sobre o OpenClaw](/blog/who-builds-openclaw), ou [pontue sua própria conta do GitHub](/) — mesmo motor, 20 segundos.*
