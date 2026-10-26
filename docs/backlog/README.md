# Backlog

Milestones, user stories and acceptance criteria. The overall roadmap (M0–M9) is summarised below; detailed, refined stories live in one file per milestone group.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Foundations: monorepo, Scene schema, CI | ✅ done |
| M1 | 3D shell from JSON: walls/openings/floors, cameras, walk, selection | ✅ done (pending user check-in) |
| M2 | Sun (suncalc + site context from IGN), sky, lamps, presets | ⏳ [m1-m2.md](m1-m2.md) |
| M3 | Command layer + scene service, undo/redo, live sync, finishes | ⏳ |
| M4 | MCP server v1: read scene, finishes, lighting, `render_view` | ⏳ |
| M5 | Asset catalog + furniture/decor placement via relations + solver | ⏳ |
| M6 | Blueprint image → Scene JSON (vision LLM + trace tool) | ⏳ |
| M7 | Inspiration image → design descriptors → MCP instruction plan | ⏳ |
| M8 | Autonomous furnishing under constraints, variants | ⏳ |
| M9 | Budget: bill of materials, budget-constrained planning | ⏳ |

Working agreement: each milestone ends with a demo, AC check, QA review by an agent, commit + push, and a user check-in before the next one starts.
