# Project guidance

Keep this file small. Put durable project rules here.

## Working style

- Inspect only the code and documentation needed for the current request. Prefer targeted search over broad repository dumps.
- Keep command output concise; summarize large logs rather than pasting them into the task.
- Read `docs/architecture.md` and `docs/developer-guide.md` before changing core retrieval, storage, or governance code.
- Verify changes with `npm run typecheck` and the relevant tests before reporting completion.

## Project facts

Record stable architecture, entry points, setup, and verification commands in `docs/architecture.md` and `docs/developer-guide.md`.
Do not store secrets, full logs, generated build output, or long meeting notes in the repository.
