## Agent skills

### Issue tracker

Issues for this repo are tracked in GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain docs use the single-context layout. See `docs/agents/domain.md`.

## Project operating model

- AI agents write all application code. Every agent-authored change must be reviewed by an engineer before it is merged.
- Hold agent-authored work to professional engineering standards. Follow established architecture, coding conventions, and patterns; keep changes understandable and reviewable.
- Run the relevant project checks and add or update tests when a change calls for them before requesting review.
- Follow the implementation latitude specified in each issue or task. There is no single project-wide rule for how much freedom an implementing agent gets.

## Documentation and planning

- Keep durable documentation in the repository focused on the project as it exists: product and engineering explanations, domain terms, and decisions already made.
- Use `README.md` for the current project overview and, once available, setup and run instructions. Add architecture or feature explanations under `docs/` or next to the related code when useful.
- Record agreed domain language in `GLOSSARY.md` and consequential decisions in `docs/adr/`.
- Track proposed work, future ideas, and roadmap items in GitHub Issues rather than repository documentation. See `docs/agents/issue-tracker.md`.
