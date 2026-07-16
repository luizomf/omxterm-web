# Domain docs

OMXTerm uses one shared domain context across its npm workspaces.

## Before exploring, read these

- `CONTEXT.md` at the repository root for canonical domain language.
- Relevant records under `docs/adr/` for durable architectural decisions.

If either location does not exist, proceed silently. The producer skill (`/grill-with-docs`) creates domain documentation lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the language belongs to the project or note the gap for `/grill-with-docs`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
