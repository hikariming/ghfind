---
title: "¿Quién construye Dify? Puntuamos a sus 100 principales contribuidores"
description: "Dify tiene 148,500 estrellas y 458 contribuidores de código. Pasamos a sus 100 principales committers por un motor de puntuación determinista: mediana de 78 frente a una línea base global de 42.5, el 71% califica como contribuidor confiable, y el trabajo está repartido entre muchas más personas de lo habitual."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Hallazgos clave** (datos recolectados el 2026-07-11, los 100 principales committers de [langgenius/dify](https://github.com/langgenius/dify), puntuados con el [motor ghfind](/methodology) open source):

- **Los 100 principales contribuidores de Dify tienen una mediana de 78.2 / 100 — 36 puntos por encima de la mediana de 42.5 de nuestra línea base de 18,947 cuentas.** El 70.8% supera el umbral de "contribuidor confiable" (puntaje ≥ 70) que solo alcanza el 20.1% de la población general.
- **Parecen desarrolladores comunes hasta que miras su producción.** Mediana de seguidores: 31 (línea base: 27). Mediana de pull requests fusionados: 118 (línea base: 20). Dify lo construyen profesionales discretos pero prolíficos, no gente que reconocerías de las redes sociales.
- **Ninguna persona domina el código — algo raro en un proyecto tan famoso.** El committer más activo escribió solo el 8.4% de los commits, los tres primeros escribieron el 21%, los diez primeros apenas menos de la mitad. Compara eso con los [proyectos virales de IA que son mayormente el trabajo de una persona](/blog/who-builds-openclaw).

## Por qué Dify

[Dify](https://github.com/langgenius/dify) es una de las plataformas de aplicaciones LLM con más estrellas de GitHub — 148,500 estrellas, 458 contribuidores de código, creada en abril de 2023. El conteo de estrellas es la forma por defecto de juzgar la salud de un proyecto, y también es el número más fácil de inflar. Así que hicimos la pregunta que las estrellas no pueden responder: **¿quién escribe realmente esto, y su trayectoria resiste cuando compruebas si es real?**

Tomamos a los 100 principales contribuidores por número de commits, excluimos 3 bots (`dependabot`, `github-actions` y — señal de los tiempos — `Copilot`), y puntuamos a los 97 humanos restantes con nuestro motor determinista. 96 se resolvieron con éxito; 86 tienen capturas completas de métricas en bruto. El motor es el mismo que hay detrás de cada puntaje de este sitio: 100 puntos en seis dimensiones, sin llamadas a modelos, entradas idénticas dan salidas idénticas.

## Calidad de los contribuidores: muy por encima de la línea base

| | Dify top-100 | Línea base 19k |
|---|---|---|
| Mediana del puntaje | **78.2** | 42.5 |
| Puntaje ≥ 90 (nivel 夯) | **15.6%** | 3.7% |
| Puntaje ≥ 70 (confiable) | **70.8%** | 20.1% |
| Puntaje < 40 (bajo valor) | **5.2%** | 48.6% |

Las dos distribuciones apenas se superponen. Incluso el contribuidor del percentil 10 de Dify (56.1) supera la mediana global por 13 puntos. Quince de los noventa y seis puntúan 90 o más — un umbral que solo alcanza una de cada veintisiete cuentas de GitHub.

Las cinco cuentas por debajo de 40 también merecen una nota: todo repositorio popular acumula una cola de gente que dejó un commit y tiene poco más en su perfil. En un proyecto sano, esa cola es aproximadamente el 5% de la lista de principales contribuidores. En la población de línea base, casi la mitad de todas las cuentas está por debajo de 40.

## Profesionales discretos

El patrón más interesante es la brecha entre lo visibles que son estas personas y cuánto producen:

| Mediana, por contribuidor | Dify top-100 | Línea base 19k |
|---|---|---|
| Seguidores | 31 | 27 |
| Pull requests fusionados | **118** | 20 |
| Edad de la cuenta | 9.0 años | 7.4 años |

Por número de seguidores, los contribuidores centrales de Dify son indistinguibles de la cuenta promedio de GitHub. Por pull requests fusionados, producen **seis veces** la línea base. Es exactamente lo opuesto al perfil de actividad falsificada que documentó nuestro [estudio de 19k cuentas](/blog/we-scored-19000-github-accounts) — las cuentas fabricadas pulen los números que todos pueden ver y se saltan el trabajo real. Los contribuidores de Dify hacen el trabajo y se saltan la autopromoción.

Las edades de las cuentas cuentan la misma historia: solo 4 de las 86 cuentas con datos completos tienen menos de un año. No es una multitud de cuentas nuevas persiguiendo un repositorio de moda — el contribuidor típico lleva en GitHub desde 2017.

## La actividad falsa aparece incluso aquí

Dos cuentas del top 100 (2.1%) superan el umbral que nuestro motor usa para el farming — la práctica de fabricar un historial de contribuciones a base de pull requests repetitivos y de bajo esfuerzo. En la población de línea base esa tasa es del 0.58%. Al volver a ejecutar el motor actual sobre las últimas capturas, una de las dos queda marcada (1.2%). Señales de advertencia de cualquier tipo aparecen en 13 de 86 cuentas (15.1%, línea base 17%), pero casi todas dicen "este perfil es flaco" (`mostly_forks`: 12) y no "este perfil es falso": exactamente una cuenta muestra títulos de PR producidos en masa, y una muestra un historial construido sobre PRs triviales.

Reportamos esto solo en agregado, pero el punto general se sostiene: **ser un proyecto famoso no mantiene limpia tu lista de los 100 principales contribuidores.** La popularidad atrae este comportamiento, porque los pequeños PRs de plantilla fusionados en un repositorio famoso son la línea de currículum más barata del mercado. Ese es precisamente el problema que nuestra próxima herramienta para mantenedores está diseñada para atrapar.

## Construido por muchas manos

Total de commits en la muestra del top 100: 8,434.

| Proporción de commits | |
|---|---|
| Contribuidor más activo | 8.4% |
| Top 3 | 21.0% |
| Top 5 | 31.3% |
| Top 10 | 49.8% |

Más de la mitad de todos los commits viene de **fuera** de los diez primeros. Los proyectos famosos de IA suelen descansar sobre uno o dos mantenedores agotados, y dejan de moverse cuando esas personas lo hacen; que Dify reparta su trabajo tan ampliamente lo hace inusualmente difícil de romper. La cima de la tabla mezcla empleados de LangGenius con mantenedores independientes de la comunidad, y la caída del #1 (708 commits) al #10 (249) es una pendiente suave, no un acantilado.

## Los cinco infravalorados

Los contribuidores que nuestro motor puntúa más alto y a los que casi nadie sigue:

| Contribuidor | Puntaje | Nivel | Seguidores |
|---|---|---|---|
| [linw1995](/u/linw1995) | 96.4 | 夯 | 165 |
| [kurokobo](/u/kurokobo) | 94.3 | 夯 | 116 |
| [junjiem](/u/junjiem) | 93.8 | 夯 | 229 |
| [lin-snow](/u/lin-snow) | 92.3 | 夯 | 152 |
| [WH-2099](/u/WH-2099) | 89.6 | 顶级 | 31 |

Mención especial para [bowenliang123](/u/bowenliang123) (94.0, #8 por commits) y [hjlarry](/u/hjlarry) (93.6, #6 por commits): committers del top diez en uno de los proyectos de IA más populares del mundo, cada uno con menos de 170 seguidores. Si estás contratando, empieza por esta tabla — estas personas son mucho mejores de lo que sugieren sus conteos de seguidores.

## Método y limitaciones

Los puntajes provienen de la rúbrica determinista de ghfind — seis dimensiones sobre datos públicos de GitHub, sin llamadas a modelos, open source bajo AGPL. Rúbrica completa y umbrales: [metodología](/methodology). Los agregados detrás de cada tabla: [data.json](/blog/who-builds-dify/data.json).

- **El top 100 por commits no es toda la comunidad.** Dify tiene 458 contribuidores de código; puntuamos el extremo más activo. La larga cola de contribuidores ocasionales probablemente puntúa más bajo.
- **Esto es una instantánea.** Datos recolectados el 2026-07-11. Las estrellas y los commits se mueven a diario; los datos de contribuidores en vivo están en la [página del proyecto Dify](/developers/repo/langgenius/dify).
- **El conteo de commits mide volumen, no importancia.** La tabla de proporción de commits dice quién hizo más commits, no quién escribió el código del que depende todo lo demás.
- **Los hallazgos de actividad falsa se reportan solo en agregado.** Solo nombramos a individuos cuando las noticias son buenas.

---

*Explora el [tablero de contribuidores en vivo de Dify](/developers/repo/langgenius/dify), lee el [estudio complementario de OpenClaw](/blog/who-builds-openclaw), o [puntúa tu propia cuenta de GitHub](/) — el mismo motor, 20 segundos.*
