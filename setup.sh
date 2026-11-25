#!/usr/bin/env bash
# One-time local setup for MacroAI. Safe to re-run.
# Usage: ./setup.sh
set -euo pipefail

cd "$(dirname "$0")"

# Keep local and secret files out of git.
touch .gitignore
for entry in ".claude/settings.local.json" ".env*.local" ".env" ".vercel" "node_modules/" ".next/" ".DS_Store"; do
  grep -qxF "$entry" .gitignore || echo "$entry" >> .gitignore
done

# Prerequisite check (warn only; installs nothing).
warn() { echo "  ! $*"; }
echo "Checking tools:"
command -v git >/dev/null || warn "git not found"
if command -v node >/dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 20 ]] || warn "Node $major found; use Node 20 or newer"
else
  warn "Node.js not found; install Node 20+"
fi
command -v npm >/dev/null || warn "npm not found"
command -v supabase >/dev/null || warn "Supabase CLI not found (brew install supabase/tap/supabase)"
if [[ -f .env.example && ! -f .env.local ]]; then
  cp .env.example .env.local
  echo "  Created .env.local from .env.example; fill in the values."
fi

echo
echo "Done. Agent instructions are in AGENTS.md (CLAUDE.md imports it)."
echo "Start a session in this folder and ask: \"What's my next step?\""
