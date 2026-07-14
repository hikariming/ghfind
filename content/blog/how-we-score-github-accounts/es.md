---
title: "Cómo puntuamos una cuenta de GitHub, explicado en palabras simples"
description: "Un recorrido sin jerga por el motor open source detrás de ghfind: las seis cosas que mide, por qué los pull requests fusionados valen mucho más que las estrellas, los patrones de bots que penaliza y cómo ejecutar el puntuador completo tú mismo."
date: "2026-07-13"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**En una frase:** el puntaje responde una sola pregunta práctica — *¿esta cuenta de GitHub es un desarrollador real y valioso, o algo inflado para parecerlo?* — y la responde igual cada vez, usando solo datos públicos, con todas las reglas publicadas a la vista. Este artículo explica, sin jerga, exactamente cómo se construye el número.

## Por qué un puntaje, para empezar

Cada vez más decisiones dependen de un vistazo al GitHub de alguien. Un reclutador ojea un perfil antes de una llamada. Un mantenedor decide si vale la pena revisar el pull request de un desconocido. Un directorio ordena cuentas según lo impresionantes que se ven. Cada uno de esos usos crea un motivo para *falsificar* las señales — y falsificar las baratas es fácil. Las estrellas se pueden comprar. Los seguidores se pueden intercambiar. Puedes abrir cien pull requests de una línea en una tarde y llamarte "contribuidor open source".

Así que un puntaje útil no puede limitarse a sumar los números grandes y brillantes. Tiene que apoyarse en las cosas que son genuinamente difíciles de falsificar, y restarle importancia a las que no lo son. Esa única idea guía cada decisión de diseño que sigue.

## El principio único: dar peso a lo difícil de falsificar

Divide cada señal de GitHub en dos categorías.

- **Barato de falsificar:** estrellas, seguidores. Unos pocos dólares o una red de sígueme-y-te-sigo los producen.
- **Caro de falsificar:** pull requests fusionados en proyectos reales que mantiene *otra persona*, años de actividad constante, código que un mantenedor ocupado realmente aceptó.

El motor pondera mucho la segunda categoría y poco la primera. Las estrellas y los seguidores siguen contando — un proyecto genuinamente popular *debería* ayudarte — pero tienen un tope tan bajo que comprarlos apenas mueve la aguja. En cambio, lograr que código real se fusione en un repositorio conocido, lo que exige convencer a un humano que no tiene ningún motivo para ayudarte, es lo que más puntos vale en todo el tablero.

Esa es toda la filosofía. El resto es solo cómo se reparte entre seis categorías.

## Las seis cosas que mide

El puntaje va de 0 a 100, dividido en seis dimensiones. Aquí está cada una en términos simples, con su máximo de puntos.

| Dimensión | Máx | Lo que realmente pregunta |
|---|---|---|
| **Calidad de contribución** | 27 | ¿Logras que pull requests reales se fusionen en proyectos reales, y los mantenedores los aceptan? |
| **Impacto en el ecosistema** | 20 | ¿Tu código ha llegado a repositorios genuinamente populares — que no son tuyos? |
| **Calidad de proyectos originales** | 18 | ¿Has construido algo que la gente realmente usa (medido en estrellas, pero con tope)? |
| **Autenticidad de la actividad** | 17 | ¿Estás activo de forma constante a lo largo del tiempo, de maneras variadas — o fue un arranque y luego silencio? |
| **Madurez de la cuenta** | 10 | ¿Cuánto tiempo lleva existiendo y activa esta cuenta? |
| **Influencia en la comunidad** | 8 | ¿Tienes seguidores reales, con una proporción sana? |

![A dónde van los 100 puntos, por dimensión](/blog/how-we-score-github-accounts/weight-breakdown.svg "Las seis dimensiones y sus puntos máximos. Naranja = señales difíciles de falsificar; gris = las que se pueden comprar.")

Fíjate en que las dos porciones más grandes — calidad de contribución (27) e impacto en el ecosistema (20) — son exactamente las difíciles de falsificar. Las estrellas (18) y los seguidores (8), las que se pueden comprar, juntas valen menos que los pull requests fusionados por sí solos. Ese orden es justamente la idea.

### La señal que más importa: código de quién, en el repositorio de quién

El número más importante de todos es el **impacto en el ecosistema** (20 puntos), y vale la pena explicar por qué, porque es la parte más ingeniosa.

Cuenta pull requests sustanciales — de más de cinco líneas, no correcciones de typos — que se fusionaron en **repositorios populares que no te pertenecen**. Piensa en un desarrollador cuyo trabajo real vive dentro del código de un proyecto famoso, en lugar de en sus propios repositorios con estrellas. Esto no se puede falsificar. Fusionar un cambio real en un proyecto de 50,000 estrellas significa que un mantenedor sin ningún incentivo para ayudarte miró tu código y dijo que sí. Es lo más parecido que tiene GitHub a una credencial revisada por pares.

Hay una excepción deliberada. Si el repositorio popular es *tuyo* — pero genuinamente popular, con 1,000 estrellas o más — igual cuenta, porque captura al creador que dedica su tiempo a construir su propio proyecto famoso en lugar de contribuir a los de otros. Lo que **no** cuenta son los pull requests hacia tus propios repositorios diminutos. Abrir PRs contra un proyecto que creaste ayer y que nadie marca con estrella es la forma clásica de inflar un contador de contribuciones, así que esos quedan excluidos aquí (y penalizados en otra parte).

## Por qué los números grandes no se llevan todo

Un puntaje ingenuo dejaría que un repositorio viral, o una cuenta con 100,000 seguidores, dominara todo. Este no lo hace, y la razón es una sola decisión de diseño: cada número de "cuánto" pasa por una **curva de rendimientos decrecientes** antes de convertirse en puntos.

![Curva de rendimientos decrecientes: puntos ganados vs. estrellas](/blog/how-we-score-github-accounts/diminishing-returns.svg "Los puntos suben rápido hasta unos pocos miles de estrellas y luego se aplanan — así un mega-repositorio o las estrellas compradas no pueden dominar.")

En términos simples: pasar de 0 a 1,000 estrellas te da muchos puntos. Pasar de 50,000 a 51,000 no te da casi nada — ya estabas cerca del tope. La curva premia superar un umbral significativo sin dejar que un puñado de mega-números desplace todo lo demás. Un desarrollador sólido con unos miles de estrellas y un historial constante no queda enterrado bajo el único repositorio viral de otra persona. También significa que comprar estrellas tiene un valor que decrece bruscamente: las primeras estrellas compradas hacen poco, y comprar tu ascenso por la curva se vuelve caro rápidamente a cambio de casi nada.

## Las señales de alerta: atrapar a los falsos

Además de las seis dimensiones positivas, el motor resta puntos por patrones específicos y bien conocidos de trampa y bajo esfuerzo. Son las firmas de bots, spam y cuentas de granja. Algunos de los principales, en lenguaje llano:

- **Inundación de PRs con plantilla** — decenas de pull requests casi idénticos, autogenerados, normalmente dirigidos al mismo repositorio. Es la señal más fuerte de un historial de contribuciones fabricado.
- **Granja de PRs triviales** — una pila de pull requests de una línea tipo "fix typo" que rellenan un contador de contribuciones sin trabajo real.
- **Granja de auto-PRs** — abrir y fusionar tus propios pull requests en tus propios repositorios sin estrellas para inflar los números. Fusionar tu propio código no demuestra nada.
- **Granja de seguidores** — seguir a miles de cuentas para provocar follow-backs, dejando una proporción de seguidores/seguidos desbalanceada.
- **Repositorios en masa en una cuenta recién creada** — una cuenta creada el mes pasado con cincuenta repositorios casi nunca es un desarrollador real.
- **Perfil fantasma** — sin bio, casi sin seguidores, sin estrellas, apenas trabajo fusionado. No es malicioso, solo está vacío.
- **Posible inflación de estrellas** — un repositorio con muchas estrellas pero casi ningún fork ni issue, que es exactamente el aspecto de las estrellas compradas.

Las penalizaciones se acumulan, hasta un límite, así que una cuenta que activa varias de estas termina cerca del fondo sin importar lo buenos que se vean sus números en bruto. Lo crucial es que estos patrones viven al nivel del *historial* de una cuenta, no de una acción individual — un PR suelto de una línea es completamente normal; cien de ellos apuntados a un mismo repositorio, no.

## Qué significa el número final

Suma las seis dimensiones, resta las señales de alerta, y caes en uno de cuatro niveles:

| Puntaje | Nivel | Significado |
|---|---|---|
| 90–100 | **夯 (Solid)** | Desarrollador de primer nivel — alto valor, alta confianza. |
| 70–89 | **人上人 (Standout)** | Contribuidor de calidad — digno de confianza. |
| 40–69 | **NPC** | Cuenta ordinaria — señales poco notables o poco claras. |
| 0–39 | **拉完了 (Cooked)** | Bajo valor — probablemente inactiva, vacía o de granja. |

Los nombres de los niveles son deliberadamente un poco juguetones — esto empezó como una herramienta de roast — pero las bandas detrás son la misma matemática determinista para todos.

## Una nota honesta sobre lo que el puntaje *no* es

- **Solo ve actividad pública.** Alguien que hace un trabajo excelente en un repositorio privado de empresa puede verse flaco aquí. Un puntaje bajo es una afirmación sobre la huella *pública*, no un veredicto sobre la persona.
- **Es un punto de partida, no un juez.** El número está pensado para ayudar a un humano a priorizar — qué PR de un desconocido mirar primero, qué perfil merece una lectura más atenta — no para rechazar a nadie automáticamente. La evidencia detrás del puntaje importa más que el puntaje.
- **El comportamiento reciente cuenta más que la historia antigua.** La señal de impacto en el ecosistema mira pull requests recientes, así que alguien cuyas grandes contribuciones fueron todas hace años puntuará más bajo de lo que sugiere su currículum. Es intencional: mide lo que estás haciendo *ahora*.

## Es open source — ejecútalo tú mismo

Nada de esto es una caja negra, y ese es el punto. No hay ningún modelo en el circuito, ninguna ponderación oculta, ningún "confía en nosotros". La misma entrada siempre produce el mismo puntaje, y cada regla descrita arriba — cada peso, cada umbral, cada disparador de señal de alerta — está publicada bajo la licencia AGPL.

- **Lee el código:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind)
- **Instala el motor:** `npm install ghfind` o `pip install ghfind`
- **Ejecútalo localmente** con tu propio token de GitHub — nada sale de tu máquina — o llama a la API pública ([especificación OpenAPI](https://ghfind.com/openapi.json)).
- **Puntúa una cuenta individual** en tu navegador en [ghfind.com](https://ghfind.com).

Si no estás de acuerdo con un peso o un umbral, puedes leer exactamente cuál es, cambiarlo y ver el efecto. Un puntaje de confianza que la gente no puede inspeccionar no vale mucho — así que hicimos este uno que sí puedes.
