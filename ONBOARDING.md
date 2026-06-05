# Onboarding

Welcome to Roundtable. This guide is for humans contributing to or exploring the codebase. End-user usage lives in [README.md](./README.md). Engine rules and agent-oriented detail live in [AGENTS.md](./AGENTS.md).

## What this tool does

You run `roundtable "your question"`. Local AI CLIs (Codex, Claude, Gemini, Cursor) debate as peers. A leader CLI orchestrates rounds, compacts context, and writes a markdown **report** in the current directory.

## Repository map

| Path | Role |
|------|------|
| `src/cli.ts` | Entry point: config, parse args, run engine |
| `src/parser.ts` | Flags, request text, `@file` references |
| `src/context.ts` | Load referenced local files |
| `src/config.ts` | Load/save/validate `config/debate.json` |
| `src/session.ts` | Report and log file I/O |
| `src/adapters.ts` | Spawn local CLI processes |
| `src/engine/` | Debate loop (leader, actors, synthesis) |
| `src/setup/` | First-run wizard |
| `src/terminal/` | Shared interactive terminal helpers |
| `src/prompts.ts` | Prompt assembly for leader and actors |
| `src/roles.ts` | Built-in and custom role behaviors |
| `src/tui.ts` | Live debate dashboard (TTY) |
| `test/` | Node built-in test runner; shared mocks in `test/helpers/` |

Config id `cursor` maps to the `agent` binary on PATH.

## How a run flows

1. **Config** — Load `config/debate.json` or run the setup wizard.
2. **Parse** — Read the question, flags, and context file refs.
3. **Session** — Create `YYYY-MM-DD-topic.md` (report) and `.log.jsonl`.
4. **Loop** — Leader decides → optional clarification → actor round → compaction → repeat until limit or stop.
5. **Finish** — Final synthesis appended to the report.

See the mermaid diagrams in [AGENTS.md](./AGENTS.md) for the full state machine.

## Configuration

- Saved at `config/debate.json` (gitignored locally).
- Example template: [config/debate.example.json](./config/debate.example.json).
- `debateMode` is inferred: **multi-cli** (one CLI per actor) or **single-cli** (multiple roles on one CLI via `--single-cli`).

## Development

```sh
corepack pnpm install
corepack pnpm test
node src/cli.ts "your question"
```

Tests use mock subprocesses — no real model calls required.

## Where to read next

- Changing CLI flags or parsing → `src/parser.ts`
- Changing debate behavior → `src/engine/` and [AGENTS.md](./AGENTS.md) engine rules
- Changing setup UX → `src/setup/`
- Changing terminal UI → `src/terminal/` and `src/tui.ts`
