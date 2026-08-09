# ObsiSim

A Banished-inspired colony simulation game that runs inside Obsidian.
Grow a settlement from three colonists into an economic powerhouse through
simulated production chains — in tables and, since Increment 2, a live
2D world view. Since Increment 6 the colony can also die out.

## Increment 1 — Economy Core

- Deterministic tick simulation (sim-ecs): 2 ticks/s, pause / 2× / 4× / single-step
- Two production chains: berries & wheat→flour→bread, wood→planks→tools
- Workers with hunger-driven efficiency — soft pressure, and nobody died in
  its day; Increment 6 made starvation lethal and renamed the worker a colonist
- Tooled workers gain +50% efficiency while their tool lasts (1 tool per worker per 300 ticks)
- Single-slot autosave into the plugin's data.json

## Increment 2 — World View

- The colony rendered as a live 2D tile world (Excalibur) in a new **World** tab
- Buildings with state rings and batch progress, workers colored by efficiency
  (tool coverage shown as a ring) walking between posts
- Hover anything for details (staffing, state, batch, efficiency, tools); a
  legend under the canvas explains every encoding
- Economy readability: per-resource **Empties in** runway on the Dashboard and
  per-stage bottleneck status (`⚠ starved`) on the Economy chains
- Read-only in its day: Increment 3 has since made the canvas interactive

## Increment 3 — Building Placement

- Build on the world: arm a building in the World tab's palette, a ghost
  preview follows the cursor (accent = buildable, red = blocked), click to
  place — placement stays armed for repeat building
- Select any building on the canvas: move it (workers walk after it, batch
  intact — free and instant in its day; Increment 5 gave moving
  distance-scaled downtime) or demolish it (confirmed, full cost refund,
  workers walk home)
- Positions are sim truth on a fixed 24×16 map (camp band on the left),
  persisted as save v2 — old saves migrate onto exactly the layout
  increment 2 derived; they stopped being merely cosmetic in Increment 4,
  once haul distance was priced off them
- Tables keep full economic parity: construct auto-places on the legacy
  pattern, a Tile column and Demolish per row — no-WebGL play stays whole

## Increment 4 — Logistics

- Goods stop teleporting: a building banks what it makes in its own output
  buffer and stalls (**Output full**) when that buffer fills
- Haulers are a staffed role — assign them on the Dashboard — who walk to the
  fullest building, load up, and carry goods back to the camp store
- Distance is now a real cost: a building beside the camp is a one-tick walk,
  the far corner is thirteen, so where you build changes what you get
- The Economy view names the backlog — units waiting, buildings stalled,
  haulers on duty — so a production drop is never a mystery
- Save v3 persists buffers and hauler assignments; v2 colonies load as
  themselves, with empty buffers and nobody hauling yet

## Increment 5 — Validated Balance

- A headless balance harness (`tests/support/balance-harness.ts`) runs a
  scenario through the real engine and reports what a building made,
  delivered, and lost to stalls or relocation; `npm run balance:report`
  prints the full distance/hauler sweep for tuning by eye
- The measured gradient: one hauler serves a building out to leg ~4, two by
  leg 8, three by leg 13 (the far corner) — correcting increment 4's claim
  that one hauler roughly sustains one far producer
- Moving a building now costs distance-scaled ticks of downtime — at half
  the hauler's tiles-per-tick, since carrying a building is harder than
  carrying goods — instead of being instant and free; a `relocating` state
  on the canvas and a downtime column in the Buildings table make it
  visible. Free relocation used to let a player cluster everything at the
  camp and never pay increment 4's haul gradient
- The Economy view's `Prod/t` column actually reported deliveries, not
  production (OBS-4-06); it's now two columns, `Made/t` and `Delivered/t`,
  and the gap between them is the per-stage haul backlog
- Save v4 adds the relocation countdown; the v1→v4 migration chain stays
  intact

## Increment 6 — Survival & Population

- Colonists are people, not units: they are born, they age through **child →
  adult → elder**, and they die — of old age, or of starvation. Only adults can
  work, so every child is a ten-year bet and every elder a cost you planned for
- Build **houses** and the colony grows itself. A birth needs a free bed, two
  adults and food in the store, so beds are the throttle: no spare bed, no
  children, and the second house is the first real growth decision you make
- Where people sleep is now part of the map game. A colonist walks from home to
  work and a bad commute costs up to half their output — but housing beside a
  distant forester beats housing at the camp by ~1.9×, so clustering everything
  on the camp band is a tradeoff rather than the obvious play
- Food is counted in **meals per head** — roughly years of food per colonist —
  and it gates both births and arrivals. "Recruit" is now **Welcome a nomad**,
  and the button tells you which gate is shut (no bed / not enough food /
  cooldown) instead of always looking available
- Starving is slow, visible and survivable: hunger climbs to its maximum, then
  a starvation clock ticks on the Population view for most of a year before
  anyone dies — about 199 ticks from a colony's last meal to its first death
- The **Population** view is the new main screen — stage counts, beds used,
  meals/head against the birth threshold, and a colonist table with age, stage,
  home, commute, hunger and the starvation clock. The world view gains a house
  glyph, stage markers and a homeless flag, each with a legend entry
- Save v5 carries age, home and the starvation clock; a v4 colony opens as
  adults with a starter house already placed and its first four colonists
  already housed, rather than being taxed as homeless on load
- **Measured, and retuned once because of it.** `npm run balance:population`
  runs a colony that feeds itself for 12,000 ticks. At the birth threshold this
  increment first shipped, it overshot what its chain could feed and was
  **extinct by tick 7,800**. The threshold was the problem: it gates on food
  *in store*, so what it really sets is the reserve a colony still holds when
  growth stops — and that reserve is what has to cover the ten years between a
  child being born and working. `birthFoodPerHead` moved 6 → 12 (and
  `nomadFoodPerHead` 10 → 20 with it, so a stranger stays dearer than your own
  child). The same run now holds **34–40 colonists through two full
  generations with nobody starving**, its age structure swinging while the
  total does not. Caveat worth knowing: that harness staffs buildings but
  cannot *build* them, so it measures a colony pinned to four gatherer slots
  for the whole run — a player who keeps extending the food chain survived even
  at the old value. §4.1 of the increment 6 spec has the curve, the sweep the
  value was picked from, and the two structural fixes still worth having

## Development

- `npm install`
- `npm run dev` — watch-build into `demo-vault/.obsidian/plugins/obsisim/`
- Open `demo-vault/` as an Obsidian vault, enable the ObsiSim community plugin,
  and reload Obsidian (Ctrl/Cmd-R) after rebuilds
- `npm test` / `npm run lint` / `npm run build`
- `npm run test-build` — build and install into this repo's own
  `.obsidian/plugins/obsisim/` (open the repository itself as a vault to test);
  pass a path to target another vault's plugin folder
- `npm run smoke:world` — drive the real Excalibur world renderer in a
  Chromium and assert on its rendering behavior (optional; needs
  `npm i --no-save playwright-core` and a Chromium — see `scripts/world-smoke.mjs`)

## Documentation

- Spec: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md`
- Plan: `docs/superpowers/plans/2026-07-03-increment-1-economy-core.md`
- Increment 2 spec: `docs/superpowers/specs/2026-07-30-increment-2-excalibur-world-view.md`
- Increment 2 plan: `docs/superpowers/plans/2026-07-30-increment-2-excalibur-world-view.md`
- Increment 3 spec: `docs/superpowers/specs/2026-07-30-increment-3-building-placement.md`
- Increment 3 plan: `docs/superpowers/plans/2026-07-30-increment-3-building-placement.md`
- Increment 4 spec: `docs/superpowers/specs/2026-07-31-increment-4-logistics.md`
- Increment 4 plan: `docs/superpowers/plans/2026-07-31-increment-4-logistics.md`
- Increment 5 spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md`
- Increment 5 plan: `docs/superpowers/plans/2026-08-01-increment-5-validated-balance.md`
- Increment 6 spec: `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md`
  — §3.1 checks every acceptance criterion against what shipped, §4 records
  what the harness measured
- Increment 6 plan: `docs/superpowers/plans/2026-08-08-increment-6-survival-and-population.md`
- Issues: `docs/issues/README.md` — findings judged real and not fixed in the
  increment that found them
- Process: `docs/process/agent-workflow.md` — working agreements for
  agent-driven increments
- Product backlog: `docs/requirements/` — Epics → Features → PBIs for
  everything shipped so far, clustered by product area (economy, world &
  placement, logistics, population, engineering quality) rather than by a
  single catch-all epic; `docs/Product Backlog.base` is the Backlog plugin
  view over it (and over `docs/issues/`)

## Architecture (one paragraph)

`src/engine/` is a headless, UI-agnostic sim-ecs world behind a `GameEngine`
facade (commands in, immutable snapshots out). `src/app/` is a Vue 3 + Pinia
read-model over those snapshots; `src/app/world/` renders the same snapshots
as a 2D tile world via Excalibur, behind an injected renderer seam — and
since Increment 3 sends place/move/demolish commands back through the
`GameEngine` facade. `src/view/` + `src/main.ts` are the thin Obsidian shell
that hosts the app and persists saves.
