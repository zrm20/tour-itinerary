# Project skills

These repository-scoped skills are vendored unchanged from Matt Pocock’s skills repository. `upstream.json` records the exact source revision and original directories; `MATT-POCOCK-LICENSE` preserves the MIT license. Each skill includes its upstream supporting files.

Use `grill-me` (which delegates to `grilling`) to explore a design, `to-spec` to capture it, `to-tickets` to prepare approved work, and `implement` to execute a ticket. Implementation uses `tdd` and `code-review`; `codebase-design` supplies the design vocabulary referenced by TDD.

`improve-codebase-architecture` explores architectural improvements interactively, using the installed `codebase-design`, `grilling`, and `domain-modeling` skills. Its HTML report scaffold and domain-modeling templates are included.

`wait-what` asks the agent to explain its last message again in simpler language, with context and the project’s domain vocabulary.

## Additional workflows

- `ask-matt` helps choose a skill or workflow.
- `grill-with-docs` explores a design while maintaining domain terms and ADRs; `wayfinder` maps decisions for work spanning multiple sessions.
- `triage` categorizes issues and prepares agent-ready briefs.
- `implement-spec` coordinates implementation of an entire spec across its tickets.
- `diagnosing-bugs` drives debugging and regression diagnosis; `prototype` builds experiments to answer design questions.
- `research` investigates questions against primary sources; `pr` guides pull request descriptions.
- `wizard` prepares interactive scripts for setup steps requiring human action.
- `retro` reviews the coding environment after a session; `handoff` prepares context for another session.
- `teach` supports learning across sessions; `to-questionnaire` captures questions for another person.
- `writing-for-agents` guides maintenance of skills and agent-facing documentation.
- `setup-matt-pocock-skills` configures the issue tracker, triage labels, and domain layout. This project's configuration is recorded in `docs/agents/`.

The project-specific issue tracker, labels, and domain rules remain in `docs/agents/`. Planning skills are interactive. Repository skills do not configure a scheduler or automatically start an implementation task. Human review is required before merge.

For updates, fetch the desired upstream revision, review its changes and skill dependencies, replace the listed directories together with their supporting files, and update the provenance and license in the same reviewed change. Do not automatically track the upstream default branch.
