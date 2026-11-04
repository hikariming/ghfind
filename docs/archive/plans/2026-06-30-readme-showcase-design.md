# README Product Showcase Design

## Goal

Turn the English and Chinese READMEs into product-first landing pages while preserving the existing technical documentation. The opening should explain that GitHub Roast is both an evidence-based developer assessment tool and a platform for discovering and showcasing developers.

## Information hierarchy

1. Product name, language switcher, concise value proposition, and primary links.
2. A language-matched product screenshot showing a real developer profile.
3. Three core product actions: assess a GitHub account, discover developers, and showcase a generated developer identity.
4. A leaderboard screenshot that makes the discovery use case concrete.
5. The maintainer's live badge and light/dark share cards as a real showcase example.
6. Existing scoring, development, deployment, fairness, and licensing documentation.

## Visual approach

Use GitHub-compatible Markdown and restrained HTML only where alignment or image sizing needs it. Keep the layout readable on mobile, avoid fragile multi-column screenshot grids, and make every major image clickable. Use `show_img/usercard.png` in English, `show_img/usercard_cn.png` in Chinese, and `show_img/leaderboard.png` in both.

## Copy direction

The English and Chinese versions should be native counterparts rather than literal translations. The tone is confident and playful without making unverifiable claims. The discovery message should cover noteworthy peers, like-minded builders, and worthy rivals; the showcase message should explain that users can generate README-ready badges and cards.

## Validation

- Confirm every local image path exists and every hosted card URL is correct.
- Render both Markdown files sufficiently to catch malformed HTML or broken hierarchy.
- Review the diff to ensure all existing technical sections remain present.
- Run the repository's required `pnpm typecheck` and `pnpm lint` checks before completion.
