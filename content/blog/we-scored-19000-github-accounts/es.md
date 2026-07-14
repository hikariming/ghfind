---
title: "Midiendo la actividad de contribución fabricada en GitHub: evidencia de 19,000 cuentas puntuadas de forma determinista"
description: "Un estudio empírico de la autenticidad de las contribuciones en GitHub. Puntuamos 18,947 cuentas públicas con un motor determinista open source y analizamos las distribuciones de puntajes, la prevalencia y estructura del farming de pull requests, la composición de las señales de alerta y la relación entre la edad de la cuenta y el puntaje."
date: "2026-07-03"
tags: ["data", "github", "anti-abuse", "open-source"]
---

**Resumen.** La preocupación por la actividad fabricada en GitHub — pull requests con plantilla, estrellas compradas, redes de seguimiento recíproco — está muy extendida, pero la evidencia cuantitativa sobre su prevalencia y estructura es escasa. Puntuamos 18,947 cuentas públicas de GitHub con una rúbrica determinista y open source (sin llamadas a modelos; entradas idénticas producen puntajes idénticos) y conservamos capturas completas de métricas en bruto para una muestra profunda de 3,444 cuentas. Encontramos que (i) la fabricación es rara en nuestra muestra: solo el 0.58% de las cuentas supera nuestro umbral conservador de farming; (ii) cuando ocurre, es extrema y está separada de forma bimodal del comportamiento ordinario — las cuentas marcadas tienen proporciones de títulos de PR con plantilla superiores al 50% (hasta el 97%), frente a una mediana poblacional del 7%; (iii) las contribuciones de bajo esfuerzo son normales, no sospechosas: el 58% de los desarrolladores con una muestra reciente de PRs fusionados tiene al menos un PR externo trivial, mientras que solo el 0.4% exhibe un patrón mayoritariamente trivial a volumen; y (iv) el perfil dominante de "aspecto sospechoso" es vacío más que manipulado — las señales de alerta de tipo ausencia superan a las de tipo manipulación por un orden de magnitud. La mediana del puntaje aumenta de forma monótona con la edad de la cuenta, desde 18 puntos por debajo del año hasta 86 puntos más allá de los diez años, lo que es consistente con que la consistencia a largo plazo sea la señal menos susceptible de fabricación. Discutimos las implicaciones para el diseño de herramientas de detección de spam, en particular que el farming es una propiedad a nivel de patrón del historial de una cuenta y no una propiedad a nivel de evento de contribuciones individuales.

## 1. Introducción

Las evaluaciones de la credibilidad de los desarrolladores dependen cada vez más de la actividad pública en GitHub: los procesos de contratación filtran perfiles de candidatos, los mantenedores de open source hacen triaje de pull requests de contribuidores desconocidos, y las herramientas derivadas ordenan cuentas según su impacto aparente. Cada uno de esos usos crea un incentivo para fabricar las señales subyacentes. Los reportes anecdóticos de mercados de estrellas, campañas de pull requests con plantilla y esquemas de seguimiento recíproco son comunes; las mediciones sistemáticas de con qué frecuencia ocurre esa fabricación, y qué forma estadística toma, no lo son.

Un ejemplo motivador de nuestro conjunto de datos ilustra el fenómeno. Una cuenta presenta un historial de PRs fusionados que normalmente indicaría un contribuidor fuerte: un gran número de pull requests fusionados (no solo abiertos) con una tasa de aceptación casi perfecta. Una inspección más cercana muestra que el 97% de sus títulos recientes de PR son variantes de plantilla casi idénticas, y que la mayoría apunta a un único repositorio popular que la cuenta no posee. Ningún pull request individual es anómalo; la anomalía existe solo al nivel del patrón agregado. Esta observación — que la fabricación puede ser invisible evento por evento y sin embargo notoria en agregado — motiva el presente estudio.

Nos hacemos tres preguntas:

1. **Prevalencia.** ¿Qué tan común es la actividad de contribución fabricada entre las cuentas públicas de GitHub?
2. **Estructura.** Cuando la fabricación ocurre, ¿en qué se diferencia estadísticamente del comportamiento de contribución ordinario?
3. **Composición.** Entre las cuentas que activan heurísticas de integridad, ¿qué fracción refleja manipulación activa frente a mera inactividad o ausencia de trabajo original?

Para responderlas, puntuamos 18,947 cuentas públicas con una rúbrica determinista ([ghfind](https://ghfind.com)), cuyo núcleo de puntuación es open source bajo AGPL ([repositorio](https://github.com/hikariming/ghfind)), y analizamos una muestra profunda de 3,444 cuentas para las que conservamos capturas completas de métricas en bruto, incluyendo muestras a nivel de PR, rasgos de calidad de repositorios y estadísticas de la forma de la actividad. Todos los datos agregados detrás de las figuras se publican junto a este artículo ([data.json](/blog/we-scored-19000-github-accounts/data.json)).

En resumen, la fabricación es considerablemente más rara en esta muestra de lo que sugiere el discurso público; cuando está presente, es extrema en lugar de sutil; y puede separarse de la actividad ordinaria con simples umbrales a nivel de patrón.

## 2. Datos y metodología

### 2.1 Rúbrica de puntuación

El motor implementa una rúbrica determinista sobre seis dimensiones que suman 100 puntos, con penalizaciones aditivas por señales de alerta. No realiza llamadas a modelos; los puntajes son totalmente reproducibles a partir de datos públicos de GitHub. Las mismas rutas de código producen los puntajes usados por el sitio web de ghfind, los SDKs de npm/PyPI y este análisis.

| Dimensión | Máx | Señal premiada |
|---|---|---|
| Calidad de contribución | 27 | PRs fusionados (escala logarítmica), tasa de aceptación, participación en issues |
| Impacto en el ecosistema | 20 | PRs sustantivos en repositorios con muchas estrellas, profundidad como mantenedor |
| Calidad de proyectos originales | 18 | estrellas ponderadas por la sustancia del repositorio |
| Autenticidad de la actividad | 17 | actividad reciente sostenida, diversidad de tipos de actividad |
| Madurez de la cuenta | 10 | edad de la cuenta, años de actividad real |
| Influencia en la comunidad | 8 | seguidores (escala logarítmica), plausibilidad de la proporción seguidores/seguidos |

Doce reglas deterministas de señales de alerta restan puntos, incluyendo `templated_pr_flooding`, `trivial_pr_farming`, `follow_farming` y `possible_star_inflation`. Los umbrales exactos están disponibles en el repositorio. Además del puntaje público, el motor calcula un puntaje interno de probabilidad de spam/bot en una escala de 0–10, usado para proteger la integridad del leaderboard; la Sección 3.2 reporta su distribución por primera vez. Ningún otro dato no público entra en este análisis.

**Definiciones.** Llamamos *trivial* a un pull request si cambia como máximo cinco líneas y se fusiona en un repositorio con al menos 200 estrellas que el autor no posee. La *proporción de títulos con plantilla* de una cuenta es la fracción de sus títulos recientes de PR que son variantes de plantilla casi idénticas entre sí.

### 2.2 Construcción de la muestra y sesgos conocidos

La muestra comprende (a) usuarios que puntuaron voluntariamente sus propias cuentas a través del sitio web de ghfind y (b) desarrolladores ingeridos desde organizaciones open source activas. Dos propiedades de este diseño restringen la interpretación. Primero, la muestra es autoseleccionada y se inclina hacia desarrolladores genuinos y activos; toda tasa de fabricación reportada abajo debe leerse, por tanto, como una **cota inferior dentro de una población ya filtrada**, no como una estimación de GitHub en su conjunto. Segundo, con 18,947 cuentas puntuadas (3,444 con métricas profundas), la muestra es lo bastante grande para caracterizar la forma de la distribución pero es una fracción insignificante de GitHub; reportamos formas, no un censo.

## 3. Resultados

### 3.1 Distribución de puntajes

![Distribución de puntajes finales en 19k cuentas](/blog/we-scored-19000-github-accounts/score-distribution.svg "Figura 1: Distribución de puntajes finales en cubetas de 5 puntos (n = 18,947). Las bandas naranjas marcan los niveles de 70 o más.")

La *Figura 1* muestra la distribución de los puntajes finales. La mediana está justo por encima de los 40 puntos; el **48.6%** de las cuentas puntúa por debajo de 40 (el nivel que la rúbrica etiqueta como bajo valor o sospecha de relleno), mientras que solo el **3.7%** supera 90. La cubeta más poblada es la de 0–5, formada por cuentas sin trabajo original, sin pull requests fusionados y sin actividad sostenida. Incluso en una muestra sesgada hacia desarrolladores activos, la mayoría de los perfiles públicos son flacos.

Como calibración, la cuenta mediana de la muestra profunda tiene **27 seguidores, 34 estrellas totales y 20 PRs fusionados**, con una edad mediana de cuenta de siete años. Las métricas relevantes para la reputación están fuertemente concentradas en la cola superior: el percentil 90 es 1,275 seguidores y aproximadamente 5,900 estrellas; el percentil 99 es 19,000 seguidores y aproximadamente 100,000 estrellas.

### 3.2 Prevalencia y estructura del farming

![Distribución del puntaje oculto de spam](/blog/we-scored-19000-github-accounts/spam-score.svg "Figura 2: Distribución del puntaje interno de probabilidad de spam de 0–10 (n = 18,934). El 77% de las cuentas puntúa exactamente 0.")

La *Figura 2* reporta la distribución del puntaje interno de probabilidad de spam en las 18,934 cuentas para las que se calculó:

- El **77%** de las cuentas puntúa exactamente 0 — ninguna señal de farming de ningún tipo.
- El **0.58%** (110 cuentas) puntúa 3 o más, el umbral que tratamos como farming claro.
- **12 cuentas** puntúan 7 o más.

La separabilidad de las cuentas de farming no deriva de su volumen sino de su *concentración*. Entre los 2,122 desarrolladores con al menos diez pull requests recientes, la mediana de la proporción de títulos con plantilla es del **7%** — los desarrolladores ordinarios se repiten con moderación ("fix typo", "bump deps"). Todas las cuentas marcadas por inundación de plantillas tienen una proporción superior al **50%**, llegando hasta el **97%**, mientras que el percentil 99 de la población completa es del 72%. La distribución es efectivamente bimodal: no hay un continuo entre la repetición ordinaria y la generación en lote. Detectar estas cuentas no requiere ningún modelo aprendido — solo agregación a través de más de un pull request por cuenta.

### 3.3 Los pull requests triviales son normales; el farming de PRs triviales no lo es

De los 2,558 desarrolladores con una muestra reciente de PRs fusionados, el **58%** tiene al menos un PR externo trivial según la definición de la Sección 2.1. Las pequeñas correcciones de documentación y typos en repositorios prominentes son evidentemente una parte rutinaria de la participación en open source, incluso para contribuidores por lo demás fuertes.

En contraste, los desarrolladores cuyos PRs fusionados recientes son *mayoritariamente* triviales, con al menos diez de esos PRs, constituyen el **0.4%** de la muestra (11 cuentas).

La brecha entre esas dos cifras tiene consecuencias directas de diseño para las herramientas anti-abuso. Cualquier heurística que penalice los pull requests pequeños per se penaliza al 58% — recién llegados, contribuidores de documentación y ayudantes ocasionales — para atrapar a once cuentas cuyo comportamiento ya era notorio a nivel de patrón. Concluimos que el farming es una **propiedad de patrón** del historial de contribuciones de una cuenta (concentración, uso de plantillas, repetición contra un único objetivo) y no una **propiedad de evento** de ningún diff individual, y que los detectores que operan sobre eventos individuales miden la cantidad equivocada.

Un resultado paralelo se cumple para las tasas de rechazo. Entre los 2,003 desarrolladores con al menos diez PRs decididos, la mediana de la tasa de rechazo por mantenedores es del **2%**, con un percentil 90 del 13%. La tasa de aceptación aporta, por tanto, poca señal discriminativa — condicionado a tener PRs fusionados, casi todo lo que esos contribuidores envían se fusiona — y solo las tasas de rechazo extremas (la rúbrica marca por encima del 50%) son informativas.

### 3.4 Composición de las señales de alerta: la ausencia domina sobre la manipulación

Al volver a ejecutar el motor actual sobre las 3,444 cuentas de la muestra profunda, el **17%** activa al menos una señal de alerta. La *Figura 3* muestra la composición.

![Prevalencia de señales de alerta](/blog/we-scored-19000-github-accounts/red-flags.svg "Figura 3: Prevalencia de señales de alerta en la muestra profunda (n = 3,444). Las señales de tipo ausencia superan a las de tipo manipulación por un orden de magnitud.")

Las tres señales más prevalentes — `ghost_profile` (10%), `no_original_work` (8.2%) y `mostly_forks` (7.2%) — describen ausencia de sustancia más que manipulación. Las señales de engaño activo son un orden de magnitud más raras: `templated_pr_flooding` en 0.5%, `trivial_pr_farming` en 0.3%, `follow_farming` en 0.1%. La inflación de estrellas — conteos altos de estrellas con forks e issues cercanos a cero — se redondea a cero en esta muestra, aunque la autoselección plausiblemente la suprime: las cuentas con estrellas compradas difícilmente se presentan a sí mismas para ser puntuadas.

Para las herramientas de confianza construidas sobre datos de GitHub, esta composición implica dos modos de fallo cualitativamente distintos que requieren detectores distintos y tolerancias de error distintas: el caso frecuente y barato ("aquí no hay nada") y el caso raro y caro ("algo aquí fue fabricado").

### 3.5 La edad de la cuenta como señal no falsificable

![Mediana del puntaje por edad de la cuenta](/blog/we-scored-19000-github-accounts/age-vs-score.svg "Figura 4: Mediana del puntaje final por edad de la cuenta. La relación es monótona en todas las cubetas de edad.")

La mediana del puntaje sube de forma monótona con la edad de la cuenta, desde **18 puntos para cuentas de menos de un año hasta 86 para cuentas que pasaron su décimo año**, sin ningún descenso intermedio (*Figura 4*). La supervivencia contribuye a esta relación — las cuentas viejas que aparecen en la muestra son cuentas viejas que siguen en uso — pero la dirección del efecto es informativa en sí misma. Cada componente de la consistencia a largo plazo (años de actividad, repositorios envejecidos con estrellas acumuladas orgánicamente, historiales de contribución que abarcan muchas versiones) es precisamente lo que la fabricación no puede comprimir: las estrellas y los seguidores pueden adquirirse en horas, mientras que una cuenta de 2015 con nueve años de actividad no puede acuñarse en 2026. Esta asimetría justifica el peso que la rúbrica da a la madurez de la cuenta y al lapso de actividad, y es consistente con nuestra observación de que las cuentas marcadas por inundación se agrupan entre las cuentas jóvenes.

Como observación secundaria, la composición de lenguaje principal de las cuentas con puntaje alto (puntaje final ≥ 60) sigue las tendencias conocidas del ecosistema: **TypeScript (520), Python (460) y JavaScript (395)** lideran, con Rust (225) por delante de Go (189), C (184) y Java (159) (*Figura 5*).

![Lenguajes de los mejor puntuados](/blog/we-scored-19000-github-accounts/languages.svg "Figura 5: Lenguajes principales entre las cuentas con puntaje de 60 o más.")

## 4. Discusión

De los resultados se desprenden tres principios de diseño para las herramientas de integridad de contribuciones.

**Detectar patrones, no eventos.** La separación bimodal de la Sección 3.2 y la brecha del 58% frente al 0.4% de la Sección 3.3 indican que las contribuciones individuales apenas llevan señal de fabricación, mientras que los agregados a nivel de cuenta se separan limpiamente. Las heurísticas de evento único maximizan los falsos positivos contra exactamente los contribuidores — recién llegados y ayudantes de bajo volumen — que los proyectos open source más necesitan retener.

**Distinguir ausencia de manipulación.** La mayoría de las cuentas que fallan las comprobaciones de integridad están vacías, no son adversarias (Sección 3.4). Confundir las dos infla las tasas aparentes de fraude y asigna mal el esfuerzo de revisión.

**Ponderar el tiempo.** La consistencia longitudinal es la única señal examinada cuyo costo de adquisición no puede reducirse gastando dinero (Sección 3.5), lo que la convierte en el ancla natural de cualquier puntaje de credibilidad.

Guiados por estos principios, estamos construyendo una GitHub App para ayudar a los mantenedores a hacer triaje de pull requests de spam, combinando rasgos a nivel de PR (tamaño del diff, similitud de plantilla) con el historial a nivel de autor. Dado el riesgo de falsos positivos documentado en la Sección 3.3, la herramienta no cerrará pull requests automáticamente; presenta evidencia para la decisión humana. Invitamos a los mantenedores de repositorios afectados a compartir ejemplos del spam que reciben.

## 5. Limitaciones

- **Muestra autoseleccionada.** Los usuarios del sitio web más los miembros de organizaciones open source activas se inclinan hacia lo genuino y activo. Las tasas de fabricación en todo GitHub son plausiblemente más altas que las reportadas aquí; nuestros porcentajes son cotas inferiores dentro de una población filtrada.
- **Escala.** 18,947 cuentas puntuadas, 3,444 con métricas profundas. Las formas de las distribuciones son estables entre re-ejecuciones, pero la muestra no es representativa de GitHub en su conjunto.
- **Solo reporte agregado.** Todos los patrones se reportan en agregado; no se identifica ninguna cuenta individual. Los umbrales de las señales se publican para que los mantenedores puedan aplicarlos con contexto.
- **Versionado del motor.** La prevalencia de señales de alerta se recalculó con el puntuador actual sobre la última captura en bruto de cada cuenta; los puntajes de spam almacenados reflejan la versión del motor en el momento del escaneo. Ambos están incluidos en los [agregados publicados](/blog/we-scored-19000-github-accounts/data.json).

## 6. Reproducibilidad

Toda la lógica de puntuación es determinista y open source (AGPL) en [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind). El motor idéntico se distribuye vía `npm install ghfind` y `pip install ghfind`, y puede ejecutarse contra la API pública ([especificación OpenAPI](https://ghfind.com/openapi.json)) o de forma totalmente local con un token de GitHub proporcionado por el usuario. Las estadísticas agregadas detrás de cada figura de este artículo están disponibles como [data.json](/blog/we-scored-19000-github-accounts/data.json).

*Las cuentas individuales pueden puntuarse en [ghfind.com](https://ghfind.com).*
