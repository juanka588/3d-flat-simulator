# Design styles and artists

A library of prompt templates for Claude, served by the MCP server, so that different "artists" redecorate the same flat and the results can be compared. It is data, not code: one Markdown file per style.

## Where things live

```
apps/mcp/styles/
  _base.md               shared "how to work with this MCP server" (about 1k tokens)
  <style-id>.md          one style: frontmatter + the artist's brief
  roles/<role-id>.md     the lead artist and the room specialists (frontmatter `kind: role`)
apps/mcp/src/styles.ts      parser, zod schema, loader, prompt composition
apps/mcp/src/stylesMcp.ts   prompts and resources registration
apps/mcp/src/styles.test.ts tests (valid library, bad files, composition, MCP exposure)
```

The folder is `apps/mcp/styles/` (not under `src/`) because the files are content that people edit, review and diff without touching code; the loader reads them at start-up. If the module refactor moves `apps/mcp`, the folder moves with it (the loader resolves it relative to `styles.ts`).

Starter styles: `french-parisian`, `scandinavian`, `japandi`, `brutalist`, `mid-century-modern`, `industrial-loft`, `mediterranean`, `art-deco`, `boho`, `warm-minimal` (the baseline of the first design sessions).

## MCP surface

| Kind | Name | What |
|---|---|---|
| prompt | `design_flat_in_style {styleId, rooms?, budgetEur?, notes?}` | `_base` + style card + brief + request. `rooms` is a comma-separated list of room ids; the budget defaults to the style's `budgetHint`. |
| prompt | `design_flat_team {styleId, budgetEur?}` | the lead artist: concept, budget split, delegation, cohesion review. |
| prompt | `room_specialist {role, roomId?, styleId, brief?, budgetEur?}` | one specialist, with only the style sections of its rooms. |
| prompt | `list_styles` | ids, names, summaries (styles and roles). |
| prompt | `furnish_room {..., styleId?}` | the existing prompt; with `styleId` the style card, tone, principles and do/don't are put in front. |
| resource | `styles://list`, `styles://<id>`, `styles://roles`, `styles://roles/<id>` | Markdown (roles list is JSON). |

Prompts and resources do not appear in `tools/list`.

## Style file format

```markdown
---
id: scandinavian
name: Scandinavian
summary: One sentence (max 240 characters).
version: 1
palette:
  - { hex: "#f5f3ee", role: walls (soft white) }
materials: [...]
forms: [...]
lighting:
  kelvin: 2700
  layers: [...]
textiles: [...]
decor: [...]
avoid: [...]
budgetHint:
  totalEur: 4500
  note: optional text
searchTerms:
  sofa: [canapé 3 places tissu clair, canapé angle clair]
---

## Tone  ## Principles  ## Séjour / cuisine  ## Chambres  ## Entrée  ## Salle de bain  ## WC  ## Balcon  ## Do  ## Don't
```

All ten `##` sections are required, in any order, with exactly these names (the specialists receive only the sections of their rooms). Unknown keys are rejected, so typos are caught. The frontmatter is a small YAML subset (`key: value`, `[a, b]` lists, `{ k: v }` maps, nested maps by 2-space indentation, `- item` lists, `#` comment lines, no tabs); quote any value with a comma or a colon in it. Errors name the file, the field and the line, for example `french-parisian.md: palette.2.role: Too big: expected string to have <=60 characters`.

Body text may name tools in backticks only if they exist (a test checks this against the tool registry).

## Add a style

1. Copy `apps/mcp/styles/warm-minimal.md` to `apps/mcp/styles/<your-id>.md` and edit the frontmatter and the brief. Give it a palette that is clearly different from the others (a test checks that no two palettes are identical).
2. Add the id to `EXPECTED` in `apps/mcp/src/styles.test.ts`.
3. `npx -y pnpm@10.34.7 exec vitest run --project mcp apps/mcp/src/styles.test.ts`. Fix what the messages say.
4. Try it: `pnpm mcp:demo:design -- --style <your-id> --dry` (no model), then a real run.

## Roles (lead and specialists)

`roles/*.md` have `kind: role`, `type: lead | specialist`, `rooms` (the usual room ids), `styleSections` (which body sections the specialist receives), `tools` (MCP tool names the subagent may call) and a body with `## Scope`, `## Workflow`, `## Report`. A specialist may not list `undo`, `redo`, `checkpoint`, `restore_checkpoint`, `list_history` or `set_sun_time` (only the lead artist uses them); the loader refuses such a file. The bathroom specialist has no floor tool on purpose (the tiles stay).

The pattern: the lead takes one checkpoint, defines the shared materials, writes a brief per room and delegates. The specialists work in parallel in disjoint rooms (the scene server serialises the commands), each touches only its room, validates and renders it, and returns a short report. The lead reviews cohesion with renders, fixes clashes with follow-up tasks, and ends with `validate_layout` and the bill of materials.

## Run variants ("artists")

```
pnpm mcp:demo:design -- --style japandi
pnpm mcp:demo:design -- --style japandi --team
pnpm mcp:demo:design -- --variants french-parisian,scandinavian,brutalist [--team] [--fresh] [--resume scene.json] [--budget 5000]
pnpm mcp:demo:design -- --variants a,b,c --parallel 2
```

- `claude -p` does not run MCP prompts, so the script fetches `design_flat_in_style` (or `design_flat_team` and the `room_specialist` prompts) with `prompts/get` and inlines the text, the same way `furnish-demo.mjs` does for `furnish_room`.
- Each variant has its own throwaway scene server and data directory (never the 8787 server), and starts from the same base scene: the Charme fixture, or `--resume <scene>`. `--fresh` strips every item and light that is not in the fixture, so you compare styles on an empty flat (finishes of a resumed scene are kept).
- Sequential by default. With `--parallel N`, N sessions search the shop at the same time: live IKEA searches are slow and rate-limited, so use it only with the local catalogue (`pnpm catalog:build`); the script warns when none is found.
- Caps apply to each run: `--max-usd` (default 20) and `--max-minutes` (default 90). The script prints the worst-case total (runs times cap) before it starts.
- Output per style in `.tmp/design-variants/<style>/`: `scene.flat.json`, `renders/*.png`, `summary.md` (with a per-agent table in team mode), `bom.json`, `transcript.json`, `prompt.md` (the exact prompt sent), `agents.json` (team), `result.json`. Across styles: `.tmp/design-variants/compare.md` (cost, BOM total, tool calls, errors per style) and `.tmp/design-variants/contact-sheet.png` (rows are rooms, columns are styles, same walk camera, evening).
- `--dry` tests the harness without a model: it composes the real prompts, writes `prompt.md` and `agents.json`, then plays a short scripted session (checkpoint, two paints from the style palette, `describe_room` and `validate_layout` per room, attributed to the specialists by room in team mode) and renders. Cost is zero. `--no-render` skips the renders. `--list-styles` prints the ids.

### Team mode details

`--team` calls `claude -p` with `--agents <file>` (one subagent per specialist: `description`, `prompt` composed from `_base` + role + the style sections of its rooms, and `tools` limited to the `mcp__flat__*` tools of its role), `--tools Agent` and `--allowedTools 'mcp__flat__*' Agent`. Subagents inherit the MCP servers of the session (`--mcp-config`). The name of the subagent tool is `Agent` (older Claude Code: `Task`; set `FLAT_DESIGN_AGENT_TOOL=Task`). Per-agent tool calls, errors, turns, tokens and wall time come from the stream events (`parent_tool_use_id` links a subagent's events to the lead's `Agent` call); the cost is reported for the whole session only. The team path has been checked with `--dry` and against `claude --help`, not with a real session: check the first real run's `summary.md` Agents table and `transcript.json` for attribution and permissions.
