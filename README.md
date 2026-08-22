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
  pattern, a Tile column and Demolish per row — the Ledger is a complete read
  surface with a control for every command the engine accepts, offered as a
  **fallback** rather than an equal path (Increment 11 restated and completed
  this promise; it never claimed to be pleasant)

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

## Increment 7 — Two-Way Haul & Storage

- Goods stop teleporting in the other direction too. A recipe's inputs are no
  longer paid out of the colony store from anywhere on the map: flour has to be
  **carried** to the bakery, and a building with nothing to work with sits at
  **Waiting for input** until a hauler brings some
- Every producing building now has an in-tray beside its out-tray, and a hauler
  makes one round trip out of two jobs — walk the inputs out, load whatever that
  building has finished, carry it home. A well-sited pair of buildings gets both
  halves of its haulage for the price of one walk; measured, 88–98% of supply
  trips come home loaded
- So distance costs on the way in as well as out, which is the whole point: a
  mill or a bakery in the far corner is now genuinely worse than one on the camp
  band, where before only raw producers paid for where you put them. One hauler
  serving a processor reaches about **half as far** as one serving a forester
- **Storehouses** are a third kind of building — 20 wood and 10 planks, no staff
  needed — and a second place goods may be dropped and picked up, so a distant
  cluster can keep its stock beside itself instead of walking everything to the
  camp. Contents move to the camp if you demolish one and travel with it if you
  move it, and wealth, meals and build costs count depot stock exactly as they
  count camp stock: one ledger, several places
- Both buffers are legible with no canvas at all: an **In** column and a
  `Waiting for input` state in the Buildings table, both buffers in the selection
  panel, a storehouse's fill as `held / capacity`, and the Economy view naming
  the **input backlog** — units short, and how many buildings are idle for want
  of them — beside the output backlog it already named
- On the world view, a depot glyph with a fill ring showing how full it is, and a
  hauler carrying goods *in* drawn distinguishably from one carrying goods *out*,
  so flow direction reads at a glance. Each has its own legend entry
- Save v6 carries input buffers and storehouse contents; a v5 colony opens as
  itself, with empty in-trays, no depots, and its whole stockpile at the camp
- **Measured, and nothing retuned.** `npm run balance:report` re-ran increment
  5's entire distance/hauler sweep for raw producers, and all sixteen rows are
  byte-identical to the day they were taken — this increment did not touch what
  it did not mean to. The storehouse measured worse than its own design argued:
  nothing ever empties a depot, so it pays once (about 26 planks) and then stops,
  and beside a camp-fed building it is a small net loss. It still wins where the
  spec claims it should — beside a producer feeding a consumer, out past leg 11,
  from the third hauler onward. §4 of the increment 7 spec records both halves,
  the one constant that had a case for moving, and the second measurement that
  stopped it moving

## Increment 8 — Storehouse Transfer

- A hauler now rebalances two stores instead of only ever filling one and
  leaving it full. **Staging** pulls camp stock outward toward the demand
  around a depot; a **drain** pushes a bounded site's surplus back to camp once
  it falls below its free-space floor. Before this, a load either landed in a
  building or went home the way it came — a store site could be filled but
  never emptied
- A depot's advantage over no depot now **grows with the horizon** instead of
  staying flat: +81 / +126 / +222 / +343 planks at 600 / 1,200 / 2,400 / 4,000
  ticks, against a flat +26 / +24 / +28 before this increment. Fitted, that is
  a one-off term of ~34 planks plus a sustained rate of 0.078 planks/tick — the
  depot turns over (54–57 of 60 stored, at capacity 2% of ticks) instead of
  silting up
- Two costs are recorded rather than rescued: a depot beside a camp-fed
  processor is now a bigger loss (17% at three haulers, up from 10%,
  `OBS-8-03`), and `OBS-7-02`'s in-tray cap stays unrelieved because staging
  fires too rarely to test against it
- A transfer never inflates `Delivered/t`, conservation stays exact with
  transfers in flight, and dispatch keeps four bounds: supply is never
  displaced by a transfer, staging never outranks a stalled producer's
  collect, a drain outranks collect only below the free floor, and a drain is
  capped at what it is restoring
- The save is untouched — `LATEST_SAVE_VERSION` stays 6

## Increment 9 — Construction as Work

- The last place goods teleported and work happened for free is gone: ordering
  a building no longer completes it on the spot. A **construction site** is a
  phase an ordinary `Building` passes through — the same precedent
  `Relocation` already set — with an input buffer haulers deliver to exactly as
  they deliver to any producer, and a countdown (`buildTicks`, 30) that starts
  once materials arrive
- A site under construction provides nothing: a house shelters nobody, a
  storehouse is not a store destination, a producer makes nothing — including
  on its own construction tick
- The affordability rule is unchanged in what it promises (you still cannot
  order what you cannot pay for) but is now cumulative over the existing
  queue, so two houses ordered back to back against just enough wood for one
  correctly refuse the second
- Cancelling a site refunds every material actually delivered to it. No
  builder role — a site completes on materials plus a fixed time, with the
  labour question deferred
- **OBS-5-03 closes for free**: demolish-and-rebuild elsewhere now costs the
  full materials and the full build time, so the relocation-pricing bypass
  closes without any demolition history being persisted
- Several sites ordered together fill **round-robin** and finish late and
  together rather than one at a time — a real, measured, and deliberately
  bounded cost that Increment 10 buys back
- Save v7 carries a site's countdown and delivered materials; a v6 save loads
  with every building finished

## Increment 10 — A Build Queue That Converges

- A build order becomes a **request**: the affordability check comes out of
  the engine and all four UI surfaces, so you can order more than the colony
  can currently afford and let production catch up. Not a reservation — a
  site competes for goods through the same dispatch ranking as everything
  else
- Dispatch now serves the **oldest servable site first**, which is the change
  that makes a request model converge instead of crawl. A blocked producer
  still outranks every site, and site selection is provably independent of
  candidate order across both a mixed-kind fixture and a multi-source fixture
- Measured: the first completion in a queue of N sites is now **constant in
  N** (65 ticks at one hauler, 35 at four, for every N from 1 to 8) instead of
  growing up to **4.2×** under Increment 9's round-robin — and the last
  completion in the queue did not move by a single tick, so this is a pure
  redistribution, not new throughput
- `OBS-8-06` is measured here, not resolved: a genuinely under-resourced
  colony still stalls a queue exactly as it did before, and no queue length
  changes whether the *first* building finishes when the underlying materials
  cannot keep up
- No new save version and no balance constant retuned — `buildTicks` ships
  unchanged, because reordering completion order left the per-site countdown
  untouched

## Increment 11 — The World Screen

- The colony gets **one screen** instead of five tabs. The router drops to two
  routes — `/` is the world, `/ledger` is the tables — and everything that was
  a tab becomes a panel in a **dock**: Inspector, Colony, Population, Economy,
  Attention (new). Zero or one panel is open at a time, held in UI state
  rather than in the route, so the canvas and its WebGL context are torn down
  on exactly one round trip (the Ledger) instead of four
- All eight engine commands now dispatch from the world screen. Before this
  increment, staffing a building, assigning a hauler and welcoming a nomad
  were each reachable from one table and nowhere else — the screen that showed
  you the colony was not the screen that ran it
- **Every row that names something on the map reaches it there.** Click a
  colonist in Population and they light up on the canvas; click a starved
  building in Attention and it is selected with the Inspector one click away.
  A discriminated `Selection` type (`building` / `colonist` / `none`) and a
  new `setHighlight` fill in the plural case — "3 colonists have no bed" pulses
  all three without selecting any one of them
- The Attention panel is genuinely new: every row is a sentence over a field
  the snapshot already publishes (stalled buildings, construction shortfalls,
  runway under 30 ticks, colonists with no bed, starvation, idle adults) — the
  first surface built to answer "what is wrong" rather than "what is true"
- The Ledger fallback is completed, not just kept: `moveBuilding` gets a table
  control for the first time, closing the one gap in "table parity" that
  existed even before this increment, and a renderer failure — at boot or
  later, mid-session — now lands the player on the Ledger with a persistent
  banner naming why, rather than a dead canvas
- **No camera work.** Panning, zooming and a zoom floor are explicitly out of
  scope; a grown map still fits by shrinking tiles toward unreadability on a
  narrow pane, and that limitation is filed rather than fixed
  (`OBS-11-01`). "Focus this building" is a highlight pulse, not a camera
  move
- Below a pane-width threshold — measured by a `ResizeObserver`, not a media
  query, so it is testable without a real layout — the dock overlays the
  canvas instead of shrinking it and the rail collapses to a single Build
  popover, because ObsiSim is an Obsidian `ItemView` and can be dragged into a
  sidebar
- One palette now drives both renderers: the canvas's colour language
  (`theme.ts`) and the HTML chrome read the same CSS custom properties, so a
  `waitingForInput` row in Attention is the exact orange of the ring on that
  building, by construction. Ticking numbers use `tabular-nums` so digits stop
  jittering, and every icon outside the canvas legend is an inline SVG rather
  than an emoji, so it can take the palette's colour
- Coverage floors land for the view layer for the first time —
  `src/app/components/**` and `src/app/views/**` at 80/70/80/80, checked
  **per file** — closing `Per-View Coverage Floors`. No engine or shared file
  changed; criterion 12 of the increment 11 spec is the check that holds that
  line

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
- Increment 7 spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md`
  — §4 records what the harness measured, including the constant that was
  retuned on a branch and measured back out again
- Increment 7 plan: `docs/superpowers/plans/2026-08-09-increment-7-two-way-haul-and-storage.md`
- Increment 8 spec: `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md`
- Increment 8 plan: `docs/superpowers/plans/2026-08-10-increment-8-storehouse-transfer.md`
- Increment 9 spec: `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md`
- Increment 9 plan: `docs/superpowers/plans/2026-08-11-increment-9-construction-as-work.md`
- Increment 10 spec: `docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md`
- Increment 10 plan: `docs/superpowers/plans/2026-08-15-increment-10-a-build-queue-that-converges.md`
- Increment 11 spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md`
  — §2.8 sets the view-layer coverage floors, §3 checks every acceptance
  criterion against what shipped
- Increment 11 plan: `docs/superpowers/plans/2026-08-16-increment-11-the-world-screen.md`
- Issues: `docs/issues/` — findings judged real and not fixed in the
  increment that found them; each is parented into the product backlog below
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
