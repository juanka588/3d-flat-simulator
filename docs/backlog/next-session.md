# Next session: where we stopped (2026-10-29 evening)

## Done today (all on main)
- CG5 scoring + critic + `close_the_gap`; CG7 runner `--close-gap` (multi-view per zone, `sejour:kitchen` as its own
  target, layout intent before images, best-iteration restore, chained targets, `final-scene.flat.json`, `--publish`).
- CG8: wall panelling / dado / cornice, herringbone and chevron parquet; stand-ins for products without 3D (category
  generators, colour from words and the local product photo, frames show the photo); windowless-room exposure fix.
- Catalogue: 600 products (398 with 3D), new bathroom and kitchen categories (`catalog:reclassify`, also on read).
- Run fixes: small-room/bathroom cameras from the doorway (WC now sees the toilet), view checks, lenient
  `record_reference`, render cold-start retry and wait for the sidecar, reference time budget, sidecar memory and
  timings in `/health` (restart `pnpm imagegen` to get them).

## In flight when we stopped
- **Performance + Android agent** (worktree `.claude/worktrees/agent-a840f312e8b7bba13`, uncommitted). Brief: perf
  harness vs an older commit, interaction slowness, mobile caps emulation, `?debug=gl` overlay, CI perf budget.
  User's phone: **Pixel 8, Chrome, GitHub Pages: the neighbour buildings render but the apartment does not**
  (suspect Mali float-linear textures / shader limits in the flat's materials). If it finished, gate and merge; else
  resume it with SendMessage or restart from this brief.

## Next
1. Merge the perf/Android work; ask the user to test Pages on the Pixel 8 with `?debug=gl`.
2. Re-run close-the-gap (run 2 failed because the Mac swapped: the 38 GB image model plus Chromium). Restart the
   sidecar (`npx -y pnpm@10.34.7 imagegen`, add `-- --download` once for the aesthetic score), close heavy apps, run
   no agents in parallel, then
   `npx -y pnpm@10.34.7 mcp:demo:design -- --close-gap --style french-parisian --rooms sejour:living,sejour:kitchen,sdb,wc --iterations 3 --max-usd 6 --max-minutes 60 --publish http://127.0.0.1:8787`
   (`--publish` backs up the 8787 scene to the output folder, then loads the final scene; the user asked for that).
   Show the user the contact sheets, scores and gap reports per target.
3. Known gaps: the open door leaf shows at the edge of doorway views; balcony views are poor; appliance/decor/other
   products without 3D still render as boxes; `describe_room` doesn't report panelling.
4. Later: CG6 photo mode (path tracer), M5R leftovers, M6 blueprint parser, M9 budget. Reuse steps P12–P15 skipped.

## Local environment notes
- Scene server 127.0.0.1:8787 (tsx watch, reloads on source changes) and web dev :5173: agents never stop them.
- Image sidecar :8790 is started by the user; its model cache `.tmp/imagegen/hf-cache` is a symlink to
  `.tmp/cg-spike/hf-cache` (CLIP weights now included). Rebuild the CLIP index after a catalogue change
  (`pnpm imagegen:index`).
- Camera sheet for all rooms: `.tmp/views-sheet/views-contact-sheet.png` (`pnpm mcp:views-sheet`).
- Scratch in `.tmp/`; use the `ci-fixer` agent for CI. Timing tests flake when agents load the machine.
