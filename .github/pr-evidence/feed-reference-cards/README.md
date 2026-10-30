# Feed reference card visual evidence

Screenshots use the actual local Astro `/zh/feed` route with a replay of public feed responses and an explicitly labelled synthetic reference relationship. They demonstrate presentation only, not persisted quote metadata or a deployed release. No authentication response is mocked.

- 1280px and 390px: Light, Dark and Auto toggled; no horizontal overflow.
- Known, published X posts already in the client cache render author, text and media inside a reference card.
- Unknown trailing t.co links render a generic link card, not a verified quoted-post preview.
- Main-post X icon and attachment card retain their distinct destinations.
- Screenshots contain public post media; quoted images are rendered as images, not reconstructed HTML.

Independent review checked dependencies, component sources, Lucide icons, animation dependencies, compactness, semantic theme colors, and mobile shrink/wrap behavior. Its finding about inline short links was fixed and regression tested.
