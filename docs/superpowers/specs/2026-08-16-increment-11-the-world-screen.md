# Spec: Increment 11 — The World Screen

**Status:** Draft
**Predecessor:** `docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md`
**Backlog Feature:** `docs/requirements/The World Screen.md` (new, under a new
epic — §6)
**Issues:** resolves none. Touches no engine code, so OBS-10-01, OBS-10-02 and
OBS-10-03 are all untouched and all still open after it.

> **This is a presentation increment.** It adds no mechanic, no command, no
> snapshot field and no save version. Ten increments have built a simulation
> that is far ahead of the interface over it, and this one closes that gap
> rather than widening it further.

---

## 1. Why this increment exists

The colony is played in tables. The world view is one tab of five, and three of
the eight commands the engine accepts cannot be reached from it at all: you
staff a building from the Buildings table, you assign a hauler from the
Dashboard, and you welcome a nomad from the Population view. So the screen that
shows you the colony is not the screen that runs it, and every decision costs a
tab switch away from the only surface that shows you *where* things are — on a
map whose whole point, since increment 4, is that distance is the cost.

That is the failure this increment is judged on. Not that the game is ugly
(it is), and not that a new player is lost (they are); those are real and they
are §7's business. This one is about **where the screens put you**.

### 1.1 The hole is smaller than it feels, and that is the good news

The engine takes exactly eight commands:

| Verb | Reachable from the world today |
| --- | --- |
| `constructBuilding` | yes — the build palette |
| `moveBuilding` | yes — the selection panel |
| `demolishBuilding` | yes — the selection panel |
| `assignWorker` | **no** — Buildings table only |
| `unassignWorker` | **no** — Buildings table only |
| `assignHauler` | **no** — Dashboard only |
| `unassignHauler` | **no** — Dashboard only |
| `recruitWorker` | **no** — Population view only |

Five gaps across three concepts — staffing, haulers, nomads. Everything else
this increment does is shell, layout and legibility around a hole that is
genuinely small. The work is large; the risk is not, because the engine is not
in it.

### 1.2 Parity was already partial, which is why softening it is a correction

`docs/requirements/Table Parity for Placement.md` is Done, and the README
promises that *"no-WebGL play stays whole"*. That promise is already not quite
true: `moveBuilding` has never had a table. A player with no WebGL can build,
demolish, staff and recruit, but cannot move a building — and since increment 5
priced relocation and increment 6 made housing distance matter, moving is not a
convenience.

So this increment does not retract parity. It **restates** it, ships the missing
half of it, and demotes it in the same breath:

> The Ledger is a complete **read** surface — every number any panel shows is
> also in a table — and carries a plain control for every verb the engine
> accepts. It does not promise to be pleasant. When the renderer fails to boot
> or fatals later, the app switches to the Ledger and says why.

That is more table capability than exists today, offered as a fallback rather
than as an equal path. §2.5 is the contract; §6 records the backlog surgery.

### 1.3 What this makes harder, deliberately

- **Two surfaces per verb stays the rule**, so every new control is designed
  twice. The Ledger is allowed to be plain, but it is not allowed to be absent.
- **The view layer roughly doubles**, and it is the layer with no coverage
  floor. §2.8 closes that gap in this increment rather than after it, because a
  floor added later is a floor negotiated against code that already exists.
- **`WorldView.vue` must be split before anything can be added to it.** It is
  339 lines of a hard 500 and owns six concerns. §2.6.

---

## 2. Requirements

### 2.1 Two routes, and panels that are not routes

The router drops from five routes to two: `/` is the world, `/ledger` is the
tables. The nav strip is removed. The Ledger is reached from one control in the
top bar, and is entered automatically on renderer failure (§2.5).

Everything that was a tab becomes a **panel in a dock**, held in UI state rather
than in the route. This is not only tidier. Today `App.vue` wraps the router
view in `<keep-alive include="WorldView">` and `WorldView` carries an
`onActivated`/`onDeactivated` pair, because navigating away would tear down the
Excalibur engine and its WebGL context — and today four of the five tabs are a
navigation away, so that teardown is on the ordinary path through the app.

After this increment it is on one path only. Four of the five reasons to leave
the world become dock state and stop unmounting anything; the Ledger is still a
route, so **the keep-alive and the activate/deactivate pair are retained, not
deleted**, and they cover exactly one round trip instead of four. The claim
worth making is the narrow one: the dock never remounts the canvas, and the
Ledger round trip remains the single WebGL teardown path, handled the way it is
handled today. Criterion 5 tests both halves, because a panel-only tour cannot
tell the difference.

The screen has four regions:

```
┌───────────────────────────────────────────────────────┐
│ ▶ ⏸ Step  1× 2× 4×    Tick 4,182   👥 21  💰 1,340    │  top bar
├────┬────────────────────────────────────┬─────────────┤
│    │                                    │             │
│rail│            the canvas              │    dock     │
│    │                                    │  (0 or 1)   │
├────┴────────────────────────────────────┴─────────────┤
│ 🌾 120 ~40t   🍞 46   🪵 88   ⚒ 12    Haulers 3  − +   │  resource strip
└───────────────────────────────────────────────────────┘
```

- **Top bar** — time controls and colony vitals. Largely today's `TopBar`.
- **Rail** — the build palette, icon-first.
- **Dock** — zero or one panel (§2.3).
- **Resource strip** — stock with runway colouring, and the hauler control,
  which is the one verb belonging to the colony rather than to any building.

`NoticeBanner` and the engine-error banner are not regions: they render above
both routes, unchanged, because a rejected command must be as visible on the
Ledger as on the world screen.

**Dock behaviour.** One panel at a time. Selecting a building on the canvas
auto-opens the Inspector. Opening another panel does *not* clear the canvas
selection.

Escape is a ladder, **most transient state first**: cancel an armed place/move
mode, else clear the selection, else close the dock. It stays inert while the
view is not the active leaf, which is the guard `WorldView` already implements
and which must survive the split.

The ordering is load-bearing and the reverse of it is a live hazard, which
`WorldView.closeSelection()` already documents: *"an armed move belongs to the
selection it came from: closing the panel must disarm it, or an invisible move
keeps previewing and a canvas click still dispatches moveBuilding for the
deselected building."* A ladder that unwound the dock and the selection before
the mode would open exactly that window — move armed, nothing selected, the
next canvas click relocating a building the player can no longer see is chosen.

So the ordering above is the second line of defence, not the first. The
invariant is:

> **An armed move never outlives the Inspector that armed it, nor the selection
> it came from.**

It has two mechanisms because those are two different events, and the dock rule
above means they cannot be collapsed into one:

- **Clearing the selection cancels the move** — Escape, clicking empty ground,
  or the building being demolished under it. This lives in the UI store's
  selection setter (§2.6), which every one of those routes passes through.
- **Dismissing the Inspector cancels the move and leaves the selection alone** —
  closing the dock, or switching to another panel. Selection deliberately
  survives a panel switch, so this case cannot ride on the setter above; it
  belongs to the dock's own panel-change path.

The second bullet is the one that is easy to lose: select a building, arm Move
from its Inspector, open Attention. The Inspector is gone, the selection is
correctly still there, and without this rule the move stays armed behind a panel
that no longer shows it. Criterion 6 tests that route by name.

**No camera work.** The map is a fixed 24×16 and `fitCamera` already fits all of
it on screen, so "focus this building" is a highlight pulse rather than a pan.
Pan and zoom are out of scope (§5).

**The narrow pane is the layout constraint that matters.** ObsiSim is an
Obsidian `ItemView` and can be dragged into a sidebar. Below a width threshold
the dock **overlays** the canvas rather than shrinking it, and the rail
collapses to a single Build control opening a popover. The threshold is driven
by a `ResizeObserver` writing a flag into the UI store — a store flag rather
than a pure CSS container query, so the behaviour is assertable in jsdom (§3.7).
CSS then responds to the *pane* width via container queries, never to the
window.

### 2.2 The verbs, and where each one lands

| Verb | Today | After |
| --- | --- | --- |
| `constructBuilding` | palette + Construct table | rail palette + Ledger |
| `moveBuilding` | selection panel | Inspector + Ledger *(new in tables)* |
| `demolishBuilding` | selection panel + table | Inspector + Ledger |
| `assignWorker` / `unassignWorker` | table only | Inspector + Ledger |
| `assignHauler` / `unassignHauler` | Dashboard only | resource strip + Ledger |
| `recruitWorker` | Population view only | Population panel + Ledger |

The Ledger's `moveBuilding` control takes typed tile coordinates. It is
deliberately worse than dragging a ghost across a map; it exists so the
fallback is complete, not so it is nice.

**A control the engine would refuse is disabled with its reason stated in the
panel, not hidden in a `title` attribute.** This is an existing convention, not
a new one: `SelectionPanel` already disables Move on a construction site and
argues in a comment that "the engine's refusal and the control that offers it
must agree", and `game-store`'s `nomadBlocker` exists precisely so the disabled
Welcome-a-nomad button and the notice a click would produce cannot disagree.
The new case is staffing with no idle adults.

### 2.3 The five panels, and the rule that unifies them

**Every row that names something on the map reaches it on the canvas.** Click a
colonist in Population and they light up; click a starved bakery in Attention
and the bakery is selected with the Inspector one click away. This is what stops
the panels being a parallel game and makes them an index into this one.

Stated that loosely it is not implementable, because the rows do not all name
the same kind of thing and one of them names nothing on the map at all. So the
model is discriminated, and which rows do what is fixed here rather than left to
each panel:

```ts
type Selection =
  | { kind: 'building'; id: number }
  | { kind: 'colonist'; id: number }
  | { kind: 'none' };
```

| Row | Click does |
| --- | --- |
| Attention row naming one building | selects that building |
| Population colonist row; Inspector occupant row | selects that colonist |
| Attention row naming several colonists (*"3 colonists have no bed"*) | highlights that set; selects nothing |
| Economy stage row | highlights every building of that def; selects nothing |
| Attention runway row (*"Bread empties in ~30t"*); Colony resource row | **nothing** — a resource has no subject on the map |

Two consequences for the renderer seam, both inside `src/app/world/` and so
inside this increment's scope:

- `setSelection(buildingId)` becomes `setSelection(Selection)`. Colonists are
  hover-only today and gain a selection ring; they are already pickable, so the
  hit-testing exists and only the drawing is new.
- A new `setHighlight(ids)` carries the plural case — a transient pulse over a
  set, with no selection and no Inspector.

**An Economy stage row is a def, not a building**, which is why it highlights
rather than selects. `EconomyView` emits one row per step in `CHAINS` and
aggregates it through `staffingByDef[step.building]`, so a stage stands for
however many buildings of that def exist — none, one, or six — and it renders a
`not built` row when there are none. Selecting requires a subject and a stage
does not reliably have one.

It highlights the whole set **even when the set has exactly one member**, and
the empty set highlights nothing. A rule that selected single-instance stages
and highlighted multi-instance ones would behave differently on the same click
depending on a count the player is not looking at, which is worse than the
slightly weaker behaviour being consistent.

The inert row is inert in **both** panels, which is why its line pairs
them: a runway warning in Attention names bread exactly as a Colony row does,
and one of them selecting nothing while the other highlighted every bakery
would be a rule the player has to learn per panel. Highlighting every building
that holds or makes a resource is a reasonable feature; it is not this one, and
it is not half of this one.

**Inspector** — what `SelectionPanel` becomes. Header (name, tile, state), then
staffing as `− 2/3 +`, then the detail that building kind actually has:

- a producer: recipe, batch progress, in-tray, out-tray, work power, tooled
  workers;
- a house: beds, and its occupants as clickable rows;
- a storehouse: `held / capacity`;
- a construction site: the countdown, and its per-material shortfall as
  `have / need`.

Verbs at the foot: Move, Demolish (two-step, reusing `TwoStepButton`), Close.

**Colony** — the Dashboard's resource table in full: tier, stock, delivered/t,
consumed/t, net, runway, value. The strip along the bottom is the summary; this
is the detail behind it.

**Population** — stage counts, beds, meals-per-head against the birth
threshold, the colonist table (age, stage, home, commute, hunger, starvation
clock), and Welcome a nomad with its blocker spelled out.

**Economy** — the chains, made/delivered per stage, stage status, and the three
backlogs (output, input, build) the store already derives.

**Attention** — the one genuinely new surface. It invents nothing: every row is
a sentence over a field the snapshot already publishes.

| Condition | Row |
| --- | --- |
| `state === 'outputFull'` | *Sawmill is full — nothing is collecting from it* |
| `state === 'waitingForInput'` | *Bakery has nothing to work with* |
| `workers === 0 && workerSlots > 0` | *Forester has no one working it* |
| `constructionNeeds` non-empty | *Sawmill site needs 14 wood* |
| runway at or under 30 ticks | *Bread empties in ~30t* |
| colonists with no home | *3 colonists have no bed* |
| starvation clock running | *2 colonists are starving* |
| `idleAdults > 0` | *4 adults are idle* |

The runway threshold is 30 ticks because that is the figure `DashboardView`
already colours a runway cell at; it moves into the store with the rest of
§2.4's derivations rather than being restated here as a second number.

Each row carries a severity and selects its subject on click. It is also the
only panel that is not a relocation of something that already exists, and
therefore the first thing to cut if scope bites.

### 2.4 Attention's derivations live in the store

Every rule in the table above is written as a getter in `src/app/stores/`, not
inside the panel component. There is a gate reason as well as a taste reason:
`src/app/stores/**` is the only app path carrying a coverage floor today
(90/85/90/90 in `vitest.config.ts`), so logic placed there is gated
automatically, while the same logic in a `.vue` file is gated by nothing until
§2.8 lands — and even after §2.8, at a lower floor.

### 2.5 The fallback contract

Stated once, as §1.2 gives it, and implemented as:

- The Ledger route renders every number any panel shows, in tables.
- The Ledger route carries a control for all eight commands.
- On renderer boot failure — and on a later fatal through the existing
  `onFatal` hook — the app navigates to `/ledger` and shows a persistent banner
  naming the failure. Today this is an inline message where the canvas would
  have been; it becomes a mode.
- Nothing promises the two surfaces are equally good.

The renderer seam already supports testing this without WebGL: the factory is
injected under `WORLD_RENDERER_KEY` and `WorldView` already handles a throwing
factory. That path is kept and re-pointed, not rebuilt.

### 2.6 File boundaries, and the split that must lead the branch

`scripts/loc-baseline.json` is `maxLoc: 500` with an **empty** `files` map:
nothing in this repository is exempt. `WorldView.vue` is 339 lines and today
owns renderer lifecycle, hover and tooltip, the idle/place/move mode machine,
selection, the ghost, and the Escape listener. A dock cannot be added to it.

The split, which is worth having on its own terms:

| File | Owns |
| --- | --- |
| `src/app/views/WorldScreen.vue` | the shell — rail, stage, dock, strip, Escape ladder |
| `src/app/views/WorldStage.vue` | the canvas host — renderer creation, the snapshot sync watch, `onFatal`, hover and tooltip |
| `src/app/world/interaction.ts` | the mode machine, ghost and tile validation, as a composable |
| `src/app/components/dock/*.vue` | Inspector, Colony, Population, Economy, Attention |
| `src/app/stores/ui-store.ts` | dock panel, the `Selection` and the highlight set, narrow-layout flag |
| `src/app/views/LedgerView.vue` | composes the table views; owns no figures of its own |

Two of these are load-bearing beyond line count. `interaction.ts` makes the
mode machine testable with no canvas and no DOM, which none of it is today.
And **selection has to move into the store**: `WorldView` owns it now, and
after §2.3 both the canvas and every panel row write it. That is also where
§2.1's cancel-on-clear invariant lives — in the setter every one of those
writers goes through, rather than in the close handler of any one component,
which is how it survives being split across six files.

`LedgerView` composes the four existing table views rather than restating them,
which is also what keeps it under the cap: `BuildingsView`, `DashboardView`,
`PopulationView` and `EconomyView` survive as components, losing their routes
and gaining the controls §2.2 owes them.

### 2.7 One figure, one derivation, two surfaces

Every number now appears twice — once in a panel, once in the Ledger — and the
rule is the repo's existing one rather than a new one: **the two readers share a
store getter, never a second derivation.** `PopulationSummary` is the precedent,
already shared between the Dashboard and the Population view with a comment
explaining that two copies are two chances to disagree about a number the player
is comparing across screens. That argument gets stronger, not weaker, when the
comparison is between a panel and its fallback.

Where a whole block is identical in both surfaces, share the component. Where
only the figure is shared, share the getter and let the two presentations
differ — which they will, because one is a dock panel in a narrow column and the
other is a wide table.

### 2.8 The coverage floor this increment owes

`vitest.config.ts` says, in a comment beside the thresholds:

> *the sim is the product: gate it hard. Views are gated by the LOC guard and
> BuildingsView's interaction tests; their coverage floor comes later.*

This increment is later. It roughly doubles the view layer and it is the one
increment where the views **are** the product, so it adds floors for
`src/app/components/**` and `src/app/views/**` and closes
`docs/requirements/Per-View Coverage Floors.md` (status: New).

**The floors are 80 statements / 70 branches / 80 functions / 80 lines**, not
the engine's 90/85/90/90. Renderer-adjacent branches in views are not honestly
reachable in jsdom, and a floor set where it cannot be met is a floor that gets
loosened later — which is worse than a lower floor held. If the delivered code
clears a higher number, raise it then, with the evidence in hand.

### 2.9 The visual language

**One palette, two renderers.** `src/app/world/theme.ts` already documents a
rigorous colour language — red/orange/green for building state, purple for the
output-full stall, cream for tools and batch progress, cyan for in-transit,
brown for depot stock — and resolves it from Obsidian CSS variables through a
`VarReader`. The HTML chrome speaks none of it.

So: define the tokens as custom properties on `.obsisim` in `styles.css`, and
let `theme.ts` keep reading them through its existing `VarReader`. CSS becomes
the single source and the canvas follows it, rather than two lists that agree
by hand. A `waitingForInput` row in Attention is then the exact orange of the
ring on that building, by construction.

**Numbers that do not jitter.** Every figure on this screen is a live counter
rendered in a proportional face, so values twitch horizontally as digits change
width. `font-variant-numeric: tabular-nums` on every ticking number, and a
three-step scale — vitals, body, caption — in place of today's uniform
`--font-ui-small`.

**Iconography, and a boundary to respect.** The chrome uses emoji (👥 💰 ⚒ ⚠).
Emoji render differently per platform and cannot be recoloured, so they cannot
participate in the palette above. Obsidian ships Lucide via `setIcon`, but
`src/app/` deliberately never imports `obsidian` — only `src/view/` and
`src/main.ts` do, which is what keeps the app layer mountable in jsdom.
Threading an icon renderer through the injection seam would work and is not
worth it: **inline an SVG sprite** instead. No dependency, no boundary
violation, `currentColor` for free. Emoji survives only where the canvas legend
already relies on it.

**Motion, bounded.** Three named transitions — dock panel enter/leave,
attention row appear, vitals value-change flash — all behind
`prefers-reduced-motion`. Not an animation system.

**No `!important`.** `scripts/css-important-baseline.json` has an empty `files`
map and `check:css` enforces it. Styling inside somebody else's theme is
exactly where `!important` gets reached for; specificity and scoping under
`.obsisim` have to carry it instead.

Light and dark come free from Obsidian's variables, but `theme.ts` carries
hardcoded fallbacks, so both themes are a verification step rather than an
assumption.

---

## 3. Acceptance criteria

1. **Every one of the eight engine commands dispatches from the world screen**
   without visiting the Ledger. Fails today for `assignWorker`,
   `unassignWorker`, `assignHauler`, `unassignHauler` and `recruitWorker`.
2. **Every one of the eight also dispatches from the Ledger**, `moveBuilding`
   included. Fails today for `moveBuilding`, which has never had a table.
3. **A renderer failure lands the player on the Ledger with a banner, and the
   colony stays playable — in both of §2.5's two failures.** A boot failure,
   driven by making the injected factory throw; *and* a post-boot fatal, driven
   by letting the factory succeed and then invoking the `onFatal` callback it
   captured. Both assert the same navigation and the same persistent banner. The
   second case needs stating because `onFatal` is only registered after the
   factory succeeds, so the throwing-factory test cannot reach it — an
   implementation could pass a boot-only criterion while leaving a mid-session
   WebGL loss stranded on the world route with a dead canvas. No WebGL involved
   in either.
4. **Every row click resolves to what §2.3's table says it resolves to** — a
   building selection, a colonist selection, a highlight set, or nothing —
   asserted against the UI store rather than against pixels. The inert case
   (Colony's resource rows) is tested too, so "not selectable" stays a decision
   rather than becoming an omission nobody notices.
5. **The renderer factory is called exactly once, total**, across a tour that
   visits every panel *and* makes the `/` → `/ledger` → `/` round trip. One
   call for the whole tour, not one per leg: the Ledger trip deactivates and
   reactivates the kept-alive renderer, so a second construction there is the
   WebGL teardown regression rather than the expected behaviour. The round trip
   has to be in the tour because a panel-only tour passes with the keep-alive
   deleted.
6. **The Escape ladder resolves most-transient-first** — armed mode, then
   selection, then dock — and stays inert while the view is not the active
   leaf. Separately, **an armed move outlives neither its selection nor its
   Inspector**, tested through all four routes: Escape, an empty-ground click,
   the selected building being demolished, and — the one that does not go
   through the selection setter — switching the dock to another panel, which
   must cancel the move while leaving the selection standing.
7. **Below the width threshold the dock overlays and the rail collapses**,
   driven by the `ResizeObserver` flag so it is assertable in jsdom.
8. **`npm run check:all` green**, no baseline loosened, no suppression added,
   every `src/` file at or under 500 nonblank lines.
9. **Coverage floors for `src/app/components/**` and `src/app/views/**` are in
   place at 80/70/80/80 and met.**
10. **`check:css`'s `!important` baseline is still empty.**
11. **`npm run smoke:world` passes** against the restructured DOM.
12. **`git diff --stat <increment-10 merge base>...HEAD -- src/engine src/shared`
    is empty.** Against the base and the branch head, not the working tree: the
    bare `git diff --stat src/engine src/shared` reports nothing once an engine
    edit has been staged or committed, which is precisely the state this
    criterion is checked in. If this increment finds itself editing the engine,
    something in this design was wrong and is worth re-examining rather than
    waving through.

---

## 4. Balance values

**None.** No constant is added, moved or read differently. `npm run
test:balance` and `npm run balance:report` must produce output identical to
increment 10's, and criterion 12 is the reason to expect that rather than hope
for it.

---

## 5. Out of scope

- **Onboarding and tutorialisation.** The fourth failing, and deliberately
  next: a world screen has to exist before it can teach itself.
- **Any new mechanic**, build-queue reordering included — increment 10 named it
  a good successor, and it stays one, but a player-set priority is a persisted
  engine field and this increment touches no engine.
- **Pan and zoom.** The map fits on screen; §2.1 says why this follows.
- **The open engine debt** — OBS-10-01, OBS-10-02, OBS-10-03. A pure UI branch
  neither fixes nor is blocked by any of them.
- **Sound.**
- **Overriding Obsidian's theme** rather than living inside it.

---

## 6. Backlog surgery

This increment does not fit any of the five existing epics — Economy
Simulation Core, World and Spatial Play, Logistics and Haulers, Population and
Survival, Engineering Quality and Balance Tooling. Every interface item shipped
so far hangs off the mechanic it explains, which is exactly why the interface
has never been anyone's increment.

- **New epic: `Interface and Play`.**
- **New Feature under it: `The World Screen`**, with PBIs for the shell (§2.1),
  the verbs and the Inspector (§2.2, §2.3), the panels (§2.3, §2.4), the
  Ledger fallback (§2.5), and the visual language (§2.9).
- **`Table Parity for Placement`** is superseded by a new PBI carrying §1.2's
  contract, and the README's *"no-WebGL play stays whole"* sentence is
  rewritten rather than left standing.
- **`Per-View Coverage Floors`** (Quality Gates and CI Infrastructure) is
  closed by §2.8.

One more piece of documentation debt this increment should clear while it is in
the README: **the README stops at Increment 7.** Increments 8, 9 and 10 shipped
and are documented in their specs, plans and backlog items, but never made it
into the front page.

---

## 7. What comes after

Two of the four failings that framed this increment are deliberately still
standing, and both become tractable once the world screen exists:

- **A new player is lost.** No goals, no first-hour guidance. Onboarding wants
  a stable screen to teach, which is what this increment builds.
- **You cannot see what is wrong** is *half* addressed, by the Attention panel.
  The other half — history, so a player can see that bread has been falling for
  four hundred ticks rather than only that it is low now — needs a time series
  the snapshot does not publish, and that is an engine change.
