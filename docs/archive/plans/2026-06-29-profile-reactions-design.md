# Profile Reactions Design

## Goal

Add a lightweight reaction bar to GitHub profile score pages. Reactions are available only to signed-in GitHub users and persist until the user changes or removes them.

## Interaction

- Show six fixed reactions between the profile summary card and score breakdown: 👍, 💩, 🦶, 🔥, 🫡, and 🤡.
- Each reaction shows its aggregate count.
- A signed-in user can keep at most one reaction per target profile.
- Clicking an unselected reaction selects it. Clicking another reaction replaces the previous choice atomically. Clicking the selected reaction removes it.
- Logged-out users can see counts. Clicking a reaction presents a GitHub sign-in action without changing counts.
- Successful changes animate only the affected button and count. Motion is disabled when `prefers-reduced-motion` is enabled.

## Persistence and abuse resistance

- Store reactions in Turso/libSQL using `(target_username, voter_github_id)` as the primary key.
- Store the stable numeric GitHub ID, plus the current login for moderation/debugging.
- The unique primary key enforces one durable vote per GitHub account and target profile.
- The API derives voter identity only from the authenticated session; it never accepts voter identity from the client.
- Reaction values are an allowlisted union. Target usernames use the existing GitHub username normalizer.
- A single upsert replaces an existing reaction; deletion requires the same authenticated identity.

## Data flow

1. The profile server component loads aggregate counts and, when authenticated, the viewer's selected reaction.
2. It renders a client reaction bar with that initial state.
3. The client sends `PUT /api/profile-reactions/:username` with a reaction value, or `DELETE` to remove it.
4. The API validates the session and input, updates the database, then returns authoritative counts and viewer state.
5. The client replaces optimistic state with the authoritative response and shows a localized error if the request fails.

## Failure behavior

- Missing authentication: `401`, surfaced as a GitHub sign-in prompt.
- Invalid username/reaction: `400`.
- Missing database configuration or database failure: `503`, with counts left unchanged in the UI.
- Duplicate clicks are blocked while a mutation is in flight.

## Testing

- Unit-test reaction validation and immutable count helpers.
- Database-test create, replace, remove, aggregate counts, case-normalized targets, and one-vote uniqueness.
- Route behavior is kept thin around authenticated session and database functions; typecheck and production build cover integration.
- Visually verify desktop and mobile layouts, selected state, login prompt, animation, and reduced-motion behavior.
