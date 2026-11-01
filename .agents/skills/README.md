# Project skills

These repository-scoped skills are vendored unchanged from Matt Pocock’s skills repository. `upstream.json` records the exact source revision and original directories; `MATT-POCOCK-LICENSE` preserves the MIT license. Each skill includes its upstream supporting files.

Use `grill-me` (which delegates to `grilling`) to explore a design, `to-spec` to capture it, `to-tickets` to prepare approved work, and `implement` to execute a ticket. Implementation uses `tdd` and `code-review`; `codebase-design` supplies the design vocabulary referenced by TDD.

`improve-codebase-architecture` explores architectural improvements interactively, using the installed `codebase-design`, `grilling`, and `domain-modeling` skills. Its HTML report scaffold and domain-modeling templates are included.

`wait-what` asks the agent to explain its last message again in simpler language, with context and the project’s domain vocabulary.

The project-specific issue tracker, labels, and domain rules remain in `docs/agents/`. Planning skills are interactive. Repository skills do not configure a scheduler or automatically start an implementation task. Human review is required before merge.

For updates, fetch the desired upstream revision, review its changes and skill dependencies, replace the listed directories together with their supporting files, and update the provenance and license in the same reviewed change. Do not automatically track the upstream default branch.
