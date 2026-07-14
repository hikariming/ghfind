---
title: "382,000 estrellas, un solo par de manos: ¿quién construye realmente OpenClaw?"
description: "OpenClaw se convirtió en el repositorio de más rápido crecimiento en la historia de GitHub. Puntuamos a sus 100 principales contribuidores con un motor determinista: una persona escribió el 57% de los commits, cero contribuidores muestran señales de actividad falsificada, y una quinta parte se unió a GitHub hace menos de un año."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Hallazgos clave** (datos recolectados el 2026-07-11, los 100 principales committers de [openclaw/openclaw](https://github.com/openclaw/openclaw), puntuados con el [motor ghfind](/methodology) open source):

- **El repositorio de más rápido crecimiento en la historia de GitHub es, medido en commits, mayormente una persona.** Su creador [steipete](/u/steipete) escribió 33,482 de los 58,487 commits de la muestra principal — el **57.2%**. Los tres primeros contribuidores acumulan el 81.5%, los diez primeros el 90.2%.
- **Cero actividad falsificada.** Ninguno de los 96 humanos del top 100 muestra el patrón de contribuciones fabricadas que marca nuestro motor — un patrón que aparece en el 0.58% de las cuentas incluso en nuestra línea base cuidadosamente filtrada de 18,947 cuentas. El hype es enorme; la gente detrás es real.
- **El boom de los agentes de IA está atrayendo recién llegados al open source.** El 19.6% de los principales contribuidores tiene cuentas de GitHub de menos de un año (en Dify, un proyecto más antiguo de fama comparable, es el 4.7%). Algunos ya son excelentes: el committer #3 maneja una cuenta de 2.3 años que puntúa 94.1.

## Por qué OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) necesita poca presentación: creado el 2025-11-24 por Peter Steinberger ([steipete](/u/steipete), fundador de PSPDFKit), renombrado dos veces en una sola semana de enero de 2026 (Clawdbot → Moltbot → OpenClaw), y el proyecto más rápido de la historia en alcanzar 100,000 estrellas de GitHub. Al 2026-07-11 acumula **382,580 estrellas, 80,292 forks y 368 contribuidores de código** — unos siete meses y medio después del primer commit.

Una curva de estrellas así es exactamente para lo que se construyó nuestro motor: cuando un número sube tan rápido, ¿hay algo real debajo? Tomamos a los 100 principales contribuidores por número de commits, excluimos 4 bots (incluyendo los propios `clawsweeper` y `openclaw-clownfish` del proyecto), y puntuamos a los 96 humanos. 92 tienen capturas completas de métricas en bruto.

## Calidad de los contribuidores: la cima de la lista es excelente

| | OpenClaw top-100 | Dify top-100 | Línea base 19k |
|---|---|---|---|
| Mediana del puntaje | **79.7** | 78.2 | 42.5 |
| Puntaje ≥ 90 (nivel 夯) | **21.9%** | 15.6% | 3.7% |
| Puntaje ≥ 70 (confiable) | **69.8%** | 70.8% | 20.1% |
| Puntaje < 40 (bajo valor) | **9.4%** | 5.2% | 48.6% |

(La columna de Dify viene de [nuestro estudio complementario](/blog/who-builds-dify), puntuado la misma semana con el mismo motor.)

Uno de cada cinco de los principales contribuidores de OpenClaw puntúa 90 o más; en GitHub en general, solo lo logra aproximadamente una cuenta de cada veintisiete. Cuando un proyecto tiene la atención de toda la industria, los desarrolladores excelentes se presentan a construirlo. Pero mira también el otro extremo: el 9.4% puntúa por debajo de 40, casi el doble de la tasa de Dify. Toda esa atención también atrae cuentas recién creadas con casi nada encima — la sección sobre edades de cuentas más abajo explica de dónde vienen.

## Un solo par de manos

Total de commits en la muestra del top 100: 58,487 — siete veces los 8,434 de Dify, producidos en una quinta parte del tiempo calendario.

| Proporción de commits | OpenClaw | Dify |
|---|---|---|
| Contribuidor más activo | **57.2%** | 8.4% |
| Top 3 | **81.5%** | 21.0% |
| Top 5 | **86.0%** | 31.3% |
| Top 10 | **90.2%** | 49.8% |

Los 33,482 commits de [steipete](/u/steipete) en 229 días dan **146 commits por día**. Nadie teclea tan rápido — pero alguien que dirige una flota de agentes de código y revisa lo que producen sí puede fusionar tan rápido, y así es exactamente como OpenClaw se construye, para fama de todos. El motor le da a la cuenta un **100/100**: un historial de 17 años en GitHub, 52,067 seguidores, 2,772 PRs fusionados — lo más lejos posible de una cuenta falsa. La producción es real. Simplemente está concentrada en un solo par de manos a un grado que ningún proyecto de este tamaño había mostrado jamás.

El siguiente escalón es pequeño pero serio: [vincentkoc](/u/vincentkoc) (10,502 commits, puntaje 96.5), [shakkernerd](/u/shakkernerd) (3,688, puntaje 94.1), [obviyus](/u/obviyus) (1,771, puntaje 93.2). Por debajo del décimo puesto, nadie llega ni a medio punto porcentual de los commits.

Ambas formas de construir funcionan: Dify lo escribe una comunidad genuinamente amplia; OpenClaw es una persona tomando cada decisión y avanzando más rápido que cualquier proyecto anterior. Pero los riesgos son distintos — si esa persona se detiene, todo se detiene — y un conteo de estrellas de 148k frente a 382k no te dice nada sobre cuál de los dos riesgos estás asumiendo.

## Cero actividad falsificada — y por qué aun así vale la pena decirlo

Entre los 96 humanos: **cero** cuentas en o por encima del umbral del motor para contribuciones fabricadas, ya sea usando los puntajes almacenados o recalculando con el motor actual. Aparecen señales de advertencia en 19 de 92 cuentas (20.7%), pero todas son de la variedad "perfil flaco" o "muchos PRs rechazados" — `mostly_forks` (15), `no_original_work` (10), `high_pr_rejection` (4). Ninguna muestra títulos de PR producidos en masa; ninguna muestra un historial relleno de PRs triviales. Como comparación, incluso el top 100 de Dify contiene dos cuentas así, y la tasa de línea base es del 0.58%.

Una advertencia honesta: ordenar por número de commits deja naturalmente a los falsificadores fuera de esta muestra. Su jugada característica es uno o dos PRs triviales por repositorio, y el contribuidor #100 de OpenClaw tiene 24 commits — no llegas hasta aquí corrigiendo typos. Si existe actividad falsificada alrededor de OpenClaw, vive en la larga cola de 368 contribuidores y en las [más de 2,800 identidades de correo anónimas](https://github.com/openclaw/openclaw/graphs/contributors) más allá de ellos, que este estudio no cubre. Lo que el resultado sí descarta es una acusación más seria: que los números asombrosos de OpenClaw estuvieran sostenidos por un ejército de cuentas falsas. No lo estaban. La gente en la cima de este proyecto pasa la prueba, uno por uno.

## La ola de recién llegados

La edad de las cuentas es donde OpenClaw deja de parecerse a Dify por completo:

| | OpenClaw | Dify |
|---|---|---|
| Cuentas < 1 año | **19.6%** | 4.7% |
| Cuentas < 2 años | **26.1%** | 9.3% |
| Edad mediana de la cuenta | 8.7 años | 9.0 años |

Los contribuidores caen en dos grupos bien diferenciados: un núcleo veterano que se unió a GitHub alrededor de 2017, y una quinta parte cuyas cuentas apenas existían hace un año. A estos recién llegados los atrajo al open source el boom de los agentes de IA — y no están solo de paso. El caso destacado es [shakkernerd](/u/shakkernerd): una cuenta de 2.3 años, 362 seguidores, y el puesto #3 en commits del repositorio más grande del año, con un puntaje de 94.1. Los puntajes bajos (9.4% por debajo de 40 puntos) son la otra cara de la misma ola: cuentas recién creadas cuya primera actividad open source de su vida es un pequeño arreglo en OpenClaw. Dentro de un año, o habrán construido historiales reales o se habrán apagado — volveremos a correr los números y lo averiguaremos.

## Los cinco infravalorados

Puntajes de primer nivel, audiencias diminutas — los habituales de OpenClaw a los que nadie está mirando:

| Contribuidor | Puntaje | Nivel | Seguidores | Commits aquí |
|---|---|---|---|---|
| [RomneyDa](/u/RomneyDa) | 98.4 | 夯 | 169 | 290 |
| [altaywtf](/u/altaywtf) | 97.7 | 夯 | 273 | 66 |
| [osolmaz](/u/osolmaz) | 97.2 | 夯 | 290 | 76 |
| [ngutman](/u/ngutman) | 96.0 | 夯 | 91 | 143 |
| [omarshahine](/u/omarshahine) | 93.4 | 夯 | 60 | 57 |

Mención especial para [joshavant](/u/joshavant): #7 por commits (558), puntaje 95.7, 160 seguidores. La brecha entre lo que la gente aporta y cuánta gente la mira es el tema recurrente de esta serie — quienes hacen el trabajo rara vez son a quienes siguen.

## Método y limitaciones

Los puntajes provienen de la rúbrica determinista de ghfind — seis dimensiones sobre datos públicos de GitHub, sin llamadas a modelos, open source bajo AGPL. Rúbrica completa y umbrales: [metodología](/methodology). Los agregados detrás de cada tabla: [data.json](/blog/who-builds-openclaw/data.json).

- **El top 100 por commits es la cabeza del proyecto, no toda la comunidad.** OpenClaw cuenta 368 contribuidores de código más ~2,800 identidades de correo anónimas; si existe actividad falsificada, estaría en esa cola, que no puntuamos.
- **Los conteos brutos de commits dependen del flujo de trabajo.** El estilo de OpenClaw, dirigido por agentes y con commits directos, produce muchos más commits por la misma cantidad de trabajo que un proyecto con squash-and-merge como Dify. Los porcentajes dentro de un mismo repositorio son significativos; comparar totales brutos de commits entre repositorios no lo es.
- **Esto es una instantánea.** Datos recolectados el 2026-07-11, sobre un proyecto que se mueve más rápido que cualquier otro anterior. Datos en vivo: [página del proyecto OpenClaw](/developers/repo/openclaw/openclaw).
- **Los hallazgos de actividad falsa se reportan solo en agregado.** Solo nombramos a individuos cuando las noticias son buenas.

---

*Explora el [tablero de contribuidores en vivo de OpenClaw](/developers/repo/openclaw/openclaw), lee el [estudio complementario de Dify](/blog/who-builds-dify), o [puntúa tu propia cuenta de GitHub](/) — el mismo motor, 20 segundos.*
