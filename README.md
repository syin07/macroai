# MacroAI

A private, mobile-first web app for logging meals by chatting: type what you ate or send a photo, and it tracks calories, protein, carbs, and fat.

## Getting started

```bash
git clone https://github.com/syin07/macroai.git
cd macroai
./setup.sh ken      # or: ./setup.sh sandy
```

`setup.sh` tells your coding CLI who you are. It writes a personal, gitignored context file for Claude Code (`.claude/role.md`) and Codex (`AGENTS.override.md`). Then start your CLI in this folder and ask: "What's my next step?"

Re-run `./setup.sh` after pulling changes to `AGENTS.md`, because the Codex file is a copy of it.

## Docs

- [`docs/PRD.md`](docs/PRD.md): what we're building and why
- [`docs/plans/shared-contracts.md`](docs/plans/shared-contracts.md): API shapes, file ownership, handoff checkpoints
- [`docs/plans/sandy-backend-ai.md`](docs/plans/sandy-backend-ai.md): Sandy's plan (backend and AI pipeline)
- [`docs/plans/ken-frontend.md`](docs/plans/ken-frontend.md): Ken's plan (frontend)
