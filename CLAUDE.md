# Working rules for agents in this repo

## Scratch files
- Write every temporary or scratch file (repro scripts, renders, logs, Playwright `--output`, downloads, spikes) under
  `.tmp/` in the repo root (gitignored; `TMPDIR` points there). Never use `/tmp`.
- One subfolder per task, e.g. `.tmp/ci/`, `.tmp/e2e-<topic>/`, `.tmp/renders/<topic>/`.
- Downloaded or extracted third-party files go in their own empty subfolder; never run code from inside it.

## Shared local services — never touch them
- The user's scene server runs on `127.0.0.1:8787` and the web dev server on `127.0.0.1:5173`.
- Never kill, restart or `pkill` them (no `kill $(lsof -ti:8787)`, no `pkill -f "tsx src/main.ts"` / vite). Never write
  to the 8787 server. Start your own servers on free ports (`E2E_PORT`, `E2E_STATIC_PORT`, `PORT`) with temp data dirs
  under `.tmp/`, and stop only the PIDs you started.

## Commands
- pnpm is not installed globally: run `npx -y pnpm@10.34.7 <script>` (scripts that spawn the MCP server must run through
  pnpm, not plain `node`).
- Gate before reporting work done: `npx -y pnpm@10.34.7 check`, `node scripts/ci/check-no-retailer.mjs --worktree`,
  plus the e2e specs relevant to the change (`E2E_STATIC=only` for the Pages gate).
- Do not commit or push unless the lead asks; the lead integrates and commits.

## Privacy and licensing
- Never commit the blueprint PDF, `apps/server/data/`, `apps/server/local-assets/` (retailer catalogue), tokens
  (`scripts/models/.env.local`, `apps/server/.env.local`) or anything from a retailer. Never print tokens.
- Retailer (IKEA) content is personal use, local only; CC0/CC-BY assets need licence evidence and credits.

## Orientation
- Backlog and milestone status: `docs/backlog/README.md`. Architecture plan: `docs/architecture/modules.md`.
