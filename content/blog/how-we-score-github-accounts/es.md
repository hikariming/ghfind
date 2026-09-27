---
title: "Cómo puntuamos una cuenta de GitHub, explicado en palabras simples"
description: "Un recorrido sin jerga por devscore, el motor open source detrás de ghfind: por qué pondera el trabajo real en lugar de estrellas y seguidores, cómo decide cuánto vale un proyecto y cuánto de él es tuyo, los patrones de granja a los que pone tope y qué significan las seis dimensiones de un perfil."
date: "2026-07-13"
updated: "2026-09-28"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**En una frase:** el puntaje responde una sola pregunta práctica — *¿cuánto trabajo real y valioso ha hecho este desarrollador en público?* — y la responde igual cada vez, usando solo datos públicos, con todas las reglas publicadas a la vista. Este artículo explica, sin jerga, cómo se construye el número.

## Por qué un puntaje, para empezar

Cada vez más decisiones dependen de un vistazo al GitHub de alguien. Un reclutador ojea un perfil antes de una llamada. Un mantenedor decide si vale la pena revisar el pull request de un desconocido. Un directorio ordena cuentas según lo impresionantes que se ven. Cada uno de esos usos crea un motivo para *falsificar* las señales — y las señales populares son las más fáciles de falsificar. Las estrellas se pueden comprar. Los seguidores se pueden intercambiar. Puedes abrir cien pull requests de una línea en una tarde y llamarte "contribuidor open source".

Así que un puntaje útil no puede limitarse a sumar los números grandes y brillantes. Tiene que medir el trabajo en sí e ignorar los números que se pueden comprar. Esa única idea guía cada decisión de diseño que sigue.

## El principio único: pesar el trabajo, no el aplauso

El motor detrás del puntaje se llama **devscore**. Su regla es breve: *puntuar lo que un desarrollador realmente construyó, ponderado por cuánto importa y cuánto de ello es suyo.*

- **Las estrellas y los seguidores nunca cuentan.** Ni un poco, ni con tope — cero. Miden atención, y la atención es barata de comprar.
- **El número de pull requests tampoco cuenta.** El motor mide los commits que escribiste y lo que cambiaron, así que cien PRs de una línea siguen siendo cien cambios de una línea.
- **Lo que cuenta es código que llegó a proyectos que la gente usa.** Tus propios proyectos cuentan cuando otras personas los usan; tu trabajo en proyectos ajenos cuenta cuando un mantenedor independiente lo aceptó.

## Cuánto vale un proyecto

Para cada repositorio, devscore primero pregunta cuánto importa el proyecto. Nunca mira las estrellas. Mira señales difíciles de falsificar porque exigen que otras personas *hagan* algo:

- **otros contribuidores** que escribieron código en él,
- **dependientes downstream** — paquetes que dependen de él,
- **autores externos de issues** — personas que lo usan lo suficiente como para reportar problemas,
- **forks**, con descuento porque son las más baratas de farmear de todas estas.

Cada paso de adopción diez veces mayor suma la misma cantidad, así que un kernel con miles de contribuidores queda muy por encima de una librería con veinte, mientras que un proyecto usado solo por su autor y algunos amigos se queda cerca del piso. Un proyecto que nadie más usa conserva solo una pequeña parte del trabajo hecho en él — construir algo para ti está bien, pero todavía no es algo de lo que otros dependan.

Los proyectos que son todo estrellas y ningún usuario reciben un trato especial. Un **proyecto de hype** — muchas estrellas, pero casi ningún contribuidor, autor de issues ni dependiente, o un pico promocional repentino seguido de silencio — no recibe ningún crédito de proyecto.

## Cuánto de él es tuyo

Después, devscore pregunta cuánto del trabajo de ese proyecto es tuyo. Combina tu proporción de commits con tu posición junto al autor principal, así que un co-líder de un gran proyecto cuenta como autor incluso con una proporción modesta, mientras que un contribuidor lejano detrás de un líder dominante no. Miles de commits propios cuentan como autoría sea cual sea el tamaño del proyecto.

Luego mide el trabajo en sí: cuántos commits lograste integrar, qué cambiaron (el código central cuenta más que la documentación o las tareas de mantenimiento; un cambio grande que un mantenedor aceptó cuenta más que uno diminuto) y cuántos meses duró el trabajo. Los historiales de commits que parecen generados por máquina — cada commit a la misma hora, cada cambio con la misma forma — reciben descuento.

## Proyectos ajenos: solo cuenta el trabajo aceptado

El trabajo en el repositorio de otra persona es lo más parecido que tiene GitHub a una revisión por pares — pero solo si alguien independiente realmente lo revisó. Por eso devscore cuenta el trabajo externo **solo en la medida en que un mantenedor independiente lo aceptó**:

- un PR fusionado por el autor principal del proyecto cuenta completo;
- uno aprobado sin más por alguien que no escribió nada del código cuenta la mitad;
- un PR que fusionaste tú mismo, o uno fusionado por un socio de intercambio que fusiona los tuyos a cambio, no cuenta nada;
- decenas de PRs grandes e independientes fusionados en lote durante una campaña de recompensas reciben descuento.

Revisar y fusionar el código de otras personas también es trabajo real. Un **mantenedor** — verificado por el propio registro de GitHub de tu rol en ese repositorio, nunca autodeclarado — recibe crédito por ese trabajo, y las code reviews que haces en proyectos ajenos también cuentan.

## Tiempo: años sostenidos, no arranques

Por último, devscore premia hacer esto durante años. Cuenta **años sostenidos de programación**: cada año calendario cuenta una vez, con un tope de doce meses de programación, así que repartir un año entre sesenta repositorios pequeños sigue siendo un año. El trabajo más antiguo se desvanece con una vida media de tres años (hasta un piso, así que una carrera larga nunca se borra).

Todo esto se combina en una sola curva suave de 0 a 100, con margen en la parte alta para que los mejores se separen en lugar de empatar en 100. Gana el rol más fuerte: a cada persona se la evalúa tanto como desarrollador como mantenedor, y cuenta el mejor de los dos.

## Atrapar a los falsos

La mayoría del farmeo nunca necesita una penalización, porque las señales que produce — estrellas, seguidores, número de PRs, auto-fusiones — ya no puntúan nada. Dos patrones reciben un **tope** explícito, aplicado al final:

- **PRs masivos de baja calidad.** En los peores doce meses, muchos PRs a proyectos ajenos fueron rechazados o retirados — al menos tantos como los fusionados de forma independiente — junto con al menos dos de estos: títulos hechos con plantilla, envíos duplicados, rachas de una semana en muchos repositorios o PRs gigantes de miles de líneas.
- **El patrón de influencer.** Cientos de seguidores, muy desproporcionados respecto a la ingeniería que otras personas aceptaron, sin ningún proyecto mantenido y sin ningún proyecto propio sustancial.

Un puntaje con tope queda comprimido en el rango 20–35, todavía ordenado por el trabajo subyacente. Lo crucial es que ambos topes se disparan con un *patrón* a lo largo de un historial — un PR rechazado suelto, o una cuenta popular que además publica código real, es completamente normal.

## Los seis números de un perfil

El total es el puntaje de devscore. Para hacerlo legible, cada perfil también muestra seis **dimensiones de visualización** derivadas de los factores de devscore. Explican el puntaje; no se suman para formarlo.

| Dimensión | Máx | Lo que muestra |
|---|---|---|
| **Calidad de contribución** | 27 | Trabajo aceptado de forma independiente en proyectos ajenos, más las code reviews que haces allí |
| **Impacto en el ecosistema** | 20 | El peso de tu trabajo en todos tus repositorios, o un rol de mantenedor verificado — lo que sea mayor |
| **Calidad de proyectos originales** | 18 | Tu proyecto insignia: el proyecto de ingeniería más fuerte que posees o lideras |
| **Autenticidad de la actividad** | 17 | Cuánto de tu trabajo es reciente; cae bruscamente cuando se aplica un tope por farmeo |
| **Madurez de la cuenta** | 10 | Años sostenidos de programación |
| **Influencia en la comunidad** | 8 | Con qué frecuencia los mantenedores fusionan en lugar de rechazar tus PRs, más las reviews que haces — nunca los seguidores |

## Qué significa el número final

| Puntaje | Nivel | Significado |
|---|---|---|
| 90–100 | **夯 (God)** | Legendario — trabajo de salón de la fama. |
| 80–89 | **顶级 (Elite)** | Desarrollador de primer nivel. |
| 70–79 | **人上人 (Solid)** | Contribuidor de calidad — digno de confianza. |
| 40–69 | **NPC** | Cuenta ordinaria — señales poco notables o poco claras. |
| 0–39 | **拉完了 (Trash)** | Poco trabajo público — o un patrón de granja con tope. |

Los nombres de los niveles son deliberadamente un poco juguetones — esto empezó como una herramienta de roast — pero la matemática detrás es la misma para todos.

## Una nota honesta sobre lo que el puntaje *no* es

- **Solo ve actividad pública.** Alguien que hace un trabajo excelente en repositorios privados de empresa puede verse flaco aquí. Un puntaje bajo es una afirmación sobre la huella *pública*, no un veredicto sobre la persona. Cada puntaje lleva un nivel de confianza que indica cuánta evidencia pública lo respalda.
- **Es un punto de partida, no un juez.** El número está pensado para ayudar a un humano a priorizar — qué PR de un desconocido mirar primero, qué perfil merece una lectura más atenta — no para rechazar a nadie automáticamente. La evidencia detrás del puntaje importa más que el puntaje.
- **El trabajo antiguo se desvanece, despacio.** Los años recientes cuentan más que la historia antigua, pero una trayectoria larga nunca se borra.

## Es open source — ejecútalo tú mismo

Nada de esto es una caja negra. No hay ningún modelo en el circuito ni ninguna ponderación oculta: los mismos datos públicos siempre producen el mismo puntaje, y cada regla descrita arriba — cada peso, cada umbral, cada tope — está publicada bajo la licencia AGPL.

- **Lee el código:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind) (el motor vive en `src/lib/devscore`)
- **Ejecútalo localmente** con `npx @hikariming/ghfind score <user> --local` y tu propio token de GitHub — nada sale de tu máquina — o llama a la API pública ([especificación OpenAPI](https://ghfind.com/openapi.json)).
- **Puntúa una cuenta individual** en tu navegador en [ghfind.com](https://ghfind.com).

Si no estás de acuerdo con un peso o un umbral, puedes leer exactamente cuál es, cambiarlo y ver el efecto. Un puntaje de confianza que la gente no puede inspeccionar no vale mucho — así que hicimos este uno que sí puedes.
