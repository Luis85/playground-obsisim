# ObsiSim

A Banished-inspired colony simulation game that runs inside Obsidian.
Grow a settlement from three workers into an economic powerhouse through
simulated production chains — displayed, for now, entirely in tables.

## Increment 1 — Economy Core

- Deterministic tick simulation (sim-ecs): 2 ticks/s, pause / 2× / 4× / single-step
- Two production chains: berries & wheat→flour→bread, wood→planks→tools
- Workers with hunger-driven efficiency (soft pressure — nobody dies)
- Tooled workers gain +50% efficiency while their tool lasts (1 tool per worker per 300 ticks)
- Single-slot autosave into the plugin's data.json

## Development

- `npm install`
- `npm run dev` — watch-build into `demo-vault/.obsidian/plugins/obsisim/`
- Open `demo-vault/` as an Obsidian vault, enable the ObsiSim community plugin,
  and reload Obsidian (Ctrl/Cmd-R) after rebuilds
- `npm test` / `npm run lint` / `npm run build`
- `npm run test-build` — build and install into this repo's own
  `.obsidian/plugins/obsisim/` (open the repository itself as a vault to test);
  pass a path to target another vault's plugin folder

## Documentation

- Spec: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md`
- Plan: `docs/superpowers/plans/2026-07-03-increment-1-economy-core.md`

## Architecture (one paragraph)

`src/engine/` is a headless, UI-agnostic sim-ecs world behind a `GameEngine`
facade (commands in, immutable snapshots out). `src/app/` is a Vue 3 + Pinia
read-model over those snapshots. `src/view/` + `src/main.ts` are the thin
Obsidian shell that hosts the app and persists saves.
