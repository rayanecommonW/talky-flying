# AGENTS.md

Rules for any coding agent working in this repo.

## Git

- Never add Claude (or any AI tool) as a co-author in commits. No `Co-Authored-By: Claude ...` trailer, no "Generated with Claude Code" line in commit messages or PR descriptions.
- Remote: `github.com/rayanecommonW/talky-flying`, branch `main`. Commit as the owner's configured git identity only.

## Secrets

- Keys live in `.env` (gitignored, mode 600): `ANTHROPIC_API_KEY`, `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `ELEVENLABS_API_KEY`.
- Never print, log or commit their values. Nebius credit is limited: keep test calls few and use cheap models.
- Ask the owner before creating, updating, stopping or deleting any Nebius resource.

## Phase

- Plan `docs/plan.md` is approved (2026-11-08). Build follows it.

## Run and test

- `pnpm dev` starts everything (see README). Logs in `logs/`.
- Before calling anything done: `pnpm -r typecheck`, the unit tests, and with the stack running `apps/game` integration tests, `apps/radio/tests/e2e_call.py` and `apps/web/e2e/two-pilots.mjs`.
