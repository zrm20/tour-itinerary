# Coding conventions

## Scripts and automation

- Keep one-off investigation and verification scripts outside the repository, such as in the system temporary directory.
- Add permanent scripts only for recurring project workflows, with a clear caller or documented entry point.
- Reuse existing commands and script entry points before adding another script. Extract helpers when they provide meaningful reuse or make complex logic easier to understand.
- Follow the project's language and tooling conventions. Prefer TypeScript for new backend tooling; use directly executable JavaScript when the workflow needs to run without the application build, or when required by the tool's configuration format.
