# Spec: Increment 6 — Survival & Population

**Date:** 2026-08-08
**Status:** Approved scope, pre-implementation
**Predecessor:** Increment 5 (validated balance — the harness, relocation
downtime, made vs delivered; PR #8, merged)

---

## 1. Why this increment exists

### 1.1 The colony cannot fail, and cannot stop

Five increments have built an economy: production chains, a spatial map,
output buffers, haulers, and a measured distance gradient. All of it serves
workers who are free and immortal. Workers arrive from a button on a 30-tick
cooldown, nobody dies, and no number ever forces a decision — a player who
builds more of everything is never wrong.

That leaves PRD pillar 2 — *"production, consumption, and worker needs form
feedback loops the player balances"* — the one pillar not yet standing.
Hunger exists and drives efficiency, but the loop it opens never closes: a
starving colony works at 0.2 forever and waits. There is no cost to growth, so
there is nothing to balance.

This increment closes it. Population becomes an **output of the economy**
rather than an input the player types in: colonists are born when there is food
and shelter, they age, and they die. Two of the three life stages cannot work,
so every extra colonist is a bet that pays off in ten years or starves you
first.

### 1.2 What this reverses, deliberately

Increment 1 specified (§3.5) that **nobody dies** — starvation was soft
pressure, not a fail state. That was scoped as a stance for increment 1, not a
permanent property: the PRD's own roadmap put "birth/aging/death" and
"death-spiral dynamics" in a later increment. This is that increment, and the
reversal is the point rather than a side effect.

The roadmap's ordering has already been overridden once by explicit product
decision (graphics moved from 6 to 2 because increments 3–5 needed to build on
it). Survival & population is taken next over the remaining candidates —
science, trade, events — because those three all add *more* to accumulate, and
the thing this game is missing is a reason accumulation costs something.

### 1.3 What stays exactly as measured

Nothing about the existing economy changes. Recipes, buffer caps, the haul
constants, the relocation rate, and the distance gradient increment 5 pinned
are all untouched. The balance harness's existing scenarios must keep passing
with their current thresholds — if this increment moves the haul gradient, that
is a bug in this increment, not a retune.

---

## 2. Requirements

### 2.1 Colonist, not Worker

The entity is renamed `Worker` → `Colonist` across `src/engine/`,
`src/shared/`, and `src/app/`. After this increment a four-year-old is not a
worker, and a name that describes its referent wrongly is exactly the defect
OBS-4-06 identified when `productionRate` stopped meaning production — fixed
one layer down, where the next reader meets it first.

- `Worker` → `Colonist`, `WorkerSnapshot` → `ColonistSnapshot`,
  `SavedWorker` → `SavedColonist`, `workerComponents` → `colonistComponents`,
  `STARTING_WORKERS` → `STARTING_COLONISTS`, and the save's `workers` array →
  `colonists` (save v5 rewrites every colonist record anyway, so the key rename
  rides along at no extra migration cost).
- `workerEfficiency(hunger)` → `colonistEfficiency(hunger)`: every colonist has
  an efficiency, including the children who will never spend one.

The line is **the person is a colonist; work is still work**, so three groups
of names deliberately do *not* move:

- **`WorkerSlots`, `BuildingDef.workerSlots`, `workerWorkPower`.** These name
  employment, not the entity. Only adults ever fill a slot or have a work power.
- **`SavedWorkerV2` and the other frozen legacy shapes.** They describe what a
  v2 save literally contains. Renaming a frozen record would make it describe a
  file format that never existed.
- **The `recruitWorker` / `assignWorker` / `unassignWorker` commands, and
  `lastRecruitTick`.** §2.7 changes what gates recruiting, not what it does —
  it still recruits an adult who works, so the name does not lie. Renaming the
  command union would cascade through the store, the save root, and every
  command test to buy nothing. The *UI label* becomes "Welcome a nomad"; the
  command underneath keeps its name.

This lands as **a pure mechanical rename before any new behaviour**, in its own
commit, changing no semantics. Every later task in this increment then writes
the right word from the start instead of adding files that inherit the wrong
one.

### 2.2 Age and the three stages

A new `Age { ticks }` component on every colonist, incremented once per tick by
`PopulationSystem`.

**A year is `BALANCE.yearTicks` = 100 ticks.** It matches `statsWindowTicks`
and `autosaveEveryTicks`, makes tick→age arithmetic readable without a
calculator (tick 4,200 is year 42), and retro-reads the one existing constant in
its range: `toolDurationTicks: 300` is three years.

| stage | years | assignable | eats |
| --- | --- | --- | --- |
| `child` | 0 – 9 | no | yes |
| `adult` | 10 – 54 | yes | yes |
| `elder` | 55 + | no | yes |

**Stages are derived from `Age`, never stored.** There is no maturity flag that
can drift out of step with the age sitting beside it, and no migration needed
when a band moves.

**Everyone eats the same.** A child is a full mouth with no hands. Tiered
consumption was considered and rejected: it is more code and it weakens the
mechanic, since the whole point is that a dependent costs what an adult costs.

**Age does not affect efficiency.** Three concerns stay separate and each has
exactly one owner: the **stage** gates assignability, **hunger** drives
efficiency, and **commute** scales contribution. An age-efficiency curve on top
would make an elder's retirement a gradual invisible fade instead of a dated
event the player can plan around.

An adult who reaches the elder band is **unassigned from its job or hauling
role** by `PopulationSystem`, freeing the slot, with a notice. The
`assignWorker` command rejects a non-adult with a reason.

### 2.3 Housing

`BuildingDef.recipe` becomes `RecipeDef | null` and `BuildingDef` gains
`beds?: number`. Content validation gains the rule that **every def has exactly
one of `recipe` or `beds`** — never neither, never both.

A new `house` def: `workerSlots: 0`, `recipe: null`, `beds: BALANCE.houseBeds`,
cost in **wood and planks**. Planks currently feed only the mill, bakery, and
workshop; housing gives the plank chain a demand that scales with the colony.

A new `Home { buildingId: number | null }` component on every colonist. `null`
is homeless.

- **Occupancy is derived, never stored.** A house's occupants are the colonists
  pointing at it. There is no counter on the building to disagree with the
  colonists, and `SavedBuilding` is therefore unchanged by this increment.
- Homing is **greedy and deterministic**, and runs in two halves:
  `PopulationSystem` first **evicts** anyone whose house no longer shelters them
  (demolished, or relocating — see below), then **fills** every free bed, lowest
  colonist id first, before it considers a birth. So "a free bed exists" and
  "nobody is homeless" are the same condition, and the birth rule can test
  either one.
- A **homeless** colonist works at `BALANCE.homelessFactor` instead of a
  commute factor, and blocks nothing else — it is a penalty, not a stall.
- **Demolishing a house makes its occupants homeless**, named in the notice
  alongside the refund.
- **A relocating house shelters nobody** for the duration of its downtime; its
  occupants are homeless until it lands. Relocation downtime is otherwise a
  production concept and a house has no production, so without this rule moving
  a house would be the one free relocation in the game — exactly the hole
  increment 5 §1.2 closed for producers.
- `BuildingState` gains `'housing'`. `'relocating'` keeps its existing priority
  over everything, so a house reads `relocating` while it moves and `housing`
  otherwise. A house is never `producing`, `waitingForInput`, or `outputFull`.
- A house produces nothing, so its output buffer stays empty and
  `nextHaulTarget` already skips zero-claimable candidates. **`HaulSystem`
  needs no change** — recorded here so a later reader does not "fix" the
  omission.

### 2.4 Commute costs work

A colonist's contribution is scaled by the walk between where they sleep and
where they work:

```
commuteTicks  = ticksForDistance(distance(home, workplace), haulTilesPerTick)
commuteFactor = max(commuteFloor, 1 - commuteTicks * commutePenaltyPerTick)
```

- `ticksForDistance` and the Euclidean measure are **the existing shared law**
  (`src/shared/placement.ts`, `src/shared/haul.ts`), reused rather than
  reinvented, so "walking costs what walking costs" is one idea the player
  learns once — the same argument increment 5 §2.3 made for relocation.
- **A hauler's workplace is `CAMP_TILE`.** A hauler's job starts and ends at
  the store, so that is the tile their commute is measured to.
- An unassigned adult has no workplace and no commute; they contribute nothing
  either way.
- The factor folds into `workerWorkPower(efficiency, toolTicks, commuteFactor)`
  — the function that already exists precisely so `ProductionSystem` and
  `buildEntitySections` cannot report a different work power than the sim runs.

The pressure this creates is the reason it is in scope: haulers want to live by
the camp, a farmhand wants to live by the farm, and the farm itself wants to be
near the camp for a short haul leg. The camp band becomes contested ground, and
housing placement inherits the spatial game increments 3–5 built instead of
sitting beside it as an inert bed counter.

### 2.5 Food, measured in meals

`mealsInStore` weights each edible resource by what it actually restores
against constants that already exist, rather than counting units. **One meal is
`mealThreshold` hunger points** — what a bread delivers when eaten the moment a
colonist becomes eligible:

```
bread   = 1.0
berries = berriesHungerRestore / mealThreshold = 30 / 50 = 0.6
```

Hunger rises 1/tick and a year is 100 ticks, so **a colonist burns about two
meals a year** and `mealsPerHead` reads directly as years of food per colonist.
That single number gates both births and nomads, appears on the Population
view, and throttles growth by construction: it falls as population rises.

`ResourceDef.edible` already exists and is what the weighting iterates.

With a population of 0, `mealsPerHead` is treated as unbounded rather than a
division by zero — see §2.7.

### 2.6 Births

A birth spawns a colonist at `Age 0`. All four conditions are required:

1. a free bed exists (equivalently, by §2.3, nobody is homeless);
2. at least **two adults** are alive;
3. `mealsPerHead >= BALANCE.birthFoodPerHead`;
4. `BALANCE.birthCooldownTicks` have passed since the last birth.

The two-adult rule is a token nod to reproduction without modelling families,
couples, or genders — all explicitly out of scope (§2.15). Its real function is
that a colony cannot repopulate itself from a single survivor; recovery from
near-extinction goes through nomads, which cost more.

A birth has **no upfront food cost**. The child eating for ten years before it
can work is the cost, and charging twice would obscure which one the player is
paying.

Births emit a notice.

### 2.7 Deaths, and nomads

**Old age.** A colonist dies when `age >= lifespanFor(id)`.

**Starvation.** `Hunger` gains a `starvingTicks` counter, incremented on any
tick the colonist is pinned at `hungerMax` and reset to 0 the moment they eat.
**`HungerSystem` is its only writer** — it already owns `Hunger` and is the one
place that knows whether a colonist ate this tick; `PopulationSystem` only
reads it. Two systems writing one counter is how a starvation clock ends up
advancing twice on a tick where a colonist both starved and was fed.
At `BALANCE.starvationDeathTicks` the colonist dies. At the proposed value
that is a full year at maximum hunger — starvation is a slow, visible,
recoverable slide, not a snap, and the Population view shows the counter
climbing long before anyone dies.

Both emit a notice **naming the cause**. A death frees the colonist's bed and
job slot.

**Nomads** are increment 1's `recruitWorker` command re-gated, not a new
system. It keeps its 30-tick cooldown and its id-exhaustion check, and adds:

- a free bed, and
- `mealsPerHead >= BALANCE.nomadFoodPerHead`, deliberately **higher than the
  birth threshold** — a nomad is a grown appetite arriving today, with none of
  the ten-year delay that makes a birth cheap to start.

A nomad arrives as an adult at `BALANCE.nomadArrivalYears` ± the same id-derived
spread as §2.12. The command's rejection message names which gate failed, and
the Population view's disabled-button reason reads **the same shared
predicate** (§2.8), so the two cannot disagree.

**Nomads work at population 0.** Beds and food outlive their owners, so a
wiped-out colony with food still in the store can be restarted by welcoming
someone. This is deliberate: it removes a divide-by-zero special case *and*
means the only unrecoverable state is one the player can see coming (no food,
no beds), with the existing reset button as the floor.

### 2.8 The shared population law

A new `src/shared/population.ts`, in the same role `haul.ts` plays for
logistics: the rules as pure exported functions, unit-testable in isolation,
readable by both sides of the seam.

| export | purpose |
| --- | --- |
| `LifeStage` | `'child' \| 'adult' \| 'elder'` |
| `stageOf(ageTicks)` | the band, derived |
| `spreadFor(id, range)` | the id-derived jitter primitive (§2.12) |
| `lifespanFor(id)` | `lifespanYears + spreadFor(id, lifespanSpreadYears)` |
| `commuteFactor(...)` | §2.4 |
| `mealsInStore(...)`, `mealsPerHead(...)` | §2.5 |
| `birthBlocker(...)`, `nomadBlocker(...)` | the failed gate, or `null` |

The blocker predicates exist because the UI must *explain* a disabled button
and `src/shared/**` may not import the engine — the same constraint that put
`compareHaulCandidates` in `haul.ts` so the engine's authoritative pick and the
UI's preview could not diverge. Rates and bands arrive as arguments where
`BALANCE` would otherwise have to be imported, exactly as `haulTicks` takes
`tilesPerTick`.

### 2.9 System order

```
CommandSystem → HungerSystem → PopulationSystem → EfficiencySystem
              → ProductionSystem → HaulSystem → StatsSystem → SnapshotSystem
```

`PopulationSystem` sits third, and both neighbours are load-bearing:

- **After `HungerSystem`**, so a starvation death reads this tick's hunger and
  a colonist who found food this tick is spared.
- **Before `EfficiencySystem` and `ProductionSystem`**, so a colonist who
  retired or died this tick is unassigned before work power is summed.
  Otherwise a corpse contributes for one tick.

Within the system the order is: **age → deaths → retirements → homing →
births**. Homing precedes births so §2.6's free-bed test is meaningful, and
deaths precede homing so a bed freed this tick is reusable this tick.

### 2.10 Save v5

`SavedColonist` (renamed per §2.1) gains `ageTicks`, `homeId`, and
`starvingTicks`. `LATEST_SAVE_VERSION` goes to 5 with a v4→v5 `MigrationStep`
and a guard, per the self-policing bump `save.ts` documents.

`starvingTicks` is saved for the same reason `relocatingTicks` is (increment 5
§2.4): it is **a penalty already incurred**, and omitting it would let
save-and-reload cancel a starvation in progress. `Age` and `Home` are plainly
persistent state, not runtime scratch like `HaulTrip`.

Load-guard treatment follows the established split: structural violations no
engine could write (negative or fractional ages, a `homeId` naming no building)
are rejected in `isLoadableSave`; balance-coupled magnitudes (an age past a
shortened lifespan, a `starvingTicks` past a lowered death threshold) are
**clamped in `colonistComponents`** so retuning never orphans a save. Both
spawn paths go through that one shared function (OBS-4-02).

**The v4→v5 migration places a starter house.** A v4 colony has no houses, so
the literal migration would load every colonist homeless and halve their output
on open — taxing a save whose player could not have prepared for it. Instead
the migration:

- gives every v4 worker an adult age, staggered by id (§2.12), `homeId: null`,
  and `starvingTicks: 0`;
- places **the same starter house a fresh colony gets** (§2.11), using the
  existing deterministic auto-placement pattern so a v4 colony that already
  built on that tile gets the next one instead.

That puts a migrated colony in exactly a new colony's position: housed up to
`houseBeds`, and building for the rest. There is precedent for deterministic
fabrication at migration — v1→v2 invented every building's position — and the
alternative is a silent penalty on load.

Homing on the next tick then fills the beds, so a migrated colony's first
`houseBeds` colonists (by id) are housed and any beyond that are homeless until
the player builds.

### 2.11 The opening

A fresh colony starts with **one house already standing beside the camp**,
`houseBeds` = 4 beds against `STARTING_COLONISTS` = 3 colonists, placed by the
existing deterministic auto-placement.

This is the first pre-placed building in the game's history and it is worth the
exception: houses cost planks, planks need a sawmill, and a colony that opens
with 30 wood cannot build one for a long time. Without a starting house the
opening is spent at `homelessFactor` for reasons the player cannot act on. With
it, the pressure starts legibly instead: you are housed, you have one spare
bed, and the fourth colonist is the first thing you must build for.

Starting colonists' ages are **staggered by id** (§2.12) around
`BALANCE.startingAgeYears`, so the three founders do not die in the same year.

### 2.12 Determinism without randomness

The project has never used an RNG and does not gain one here. But a single
fixed lifespan makes every death an exact copy of a birth `lifespanYears`
earlier: the founders die together, a migrated v4 colony dies together, and a
run of births spaced by `birthCooldownTicks` produces deaths spaced identically
— visibly mechanical, and a demographic wave with no width to it.

One primitive, `spreadFor(id, range)`, derives a jitter from the entity id: a
multiplicative hash of the id, reduced modulo `2 * range + 1`, minus `range`.
It is pure, uniform over the range, stable across save/load (ids are already
unique and persisted), and needs no seed in the save. `lifespanFor` is its only
interesting caller; the same primitive staggers starting ages (§2.11) and nomad
arrival ages (§2.7), so there is one hash in the codebase rather than three.

It must be exported and unit-tested for **range** (never outside
`[-range, +range]`), **stability** (same id, same answer, across a
serialize/restore round trip), and **distribution** (a run of consecutive ids
does not collapse onto one value, nor alternate between two — the failure mode
a weak hash produces, and one a range test alone passes happily).

### 2.13 Snapshot and surfaces

`ColonistSnapshot` gains `ageTicks`, `stage`, `homeId`, `commuteTicks`,
`commuteFactor`, and `starvingTicks`. `Snapshot` gains `demographics`
(`children` / `adults` / `elders`), `beds` (`total` / `occupied`), `homeless`,
and `mealsPerHead`. `BuildingSnapshot` gains `beds` and `occupants` (0 for
producers).

- **Population view** becomes the increment's primary screen: stage counts,
  beds used, `mealsPerHead` against the birth threshold, the nomad button
  showing its live blocker reason, and a colonist table with age, stage, home,
  commute, hunger, and efficiency.
- **Dashboard** gains population-by-stage, beds, and `mealsPerHead`. The
  existing `runways` getter finally describes something fatal.
- **Buildings** table shows a house as occupants/beds where a producer shows
  batch progress, and rejects assign on a house (0 slots) as it already would.
- **Build palette** gains the house, priced and gated like any other def.
- **World view** gains a house glyph, a stage marker on colonists, and a
  homeless flag — each with a legend entry, per the standing rule that every
  encoding is explained under the canvas.
- **Notices** for birth, death (naming the cause), and retirement.

`src/app/world/renderer.ts` is at **419 non-blank lines against the hard
500-line LOC gate**, with nothing baselined — 81 lines of headroom for a house
glyph, three stage markers, and a homeless flag. That may or may not fit.
**Splitting the renderer is therefore planned work in this increment rather
than a discovery to be made mid-task**, and if the split turns out to be
unnecessary it is dropped — but the baseline is not loosened either way.

### 2.14 Testing and gates

- The balance harness gains a **population scenario** reporting the population
  curve, births, deaths by cause, `mealsPerHead`, and the dependency ratio
  (`(children + elders) / adults` — the share of the colony being carried).
  `npm run balance:report` prints it beside the existing distance/hauler sweep.
- Pinned as **relationships, not unit counts**, per increment 5 §2.2:
  - a fed colony with free beds grows; a bed-capped colony plateaus;
  - cutting food produces a visible decline **before** the first death;
  - a birth burst produces a retirement bulge one generation later;
  - a colonist housed far from their job delivers measurably less than a
    colocated one — the commute term has to show up in goods, not only in a
    unit test of `commuteFactor`.
- **Increment 5's existing balance assertions must still pass unchanged**
  (§1.3). They are the regression net proving this increment did not move the
  haul gradient.
- Every new behaviour is **mutation-tested**: break the feature, confirm the
  named test fails, restore. Assertions must discriminate — fixture values
  chosen so that binding to a neighbouring field changes the result
  (`docs/process/agent-workflow.md`).
- No vitest test may import `renderer.ts` or `graphics-cache.ts`. The canvas
  changes are covered by `npm run smoke:world`, with fixture phases that change
  **one thing each**.
- Save v5 needs round-trip, v4→v5, and full v1→v5 chain tests, including a
  mid-starvation save reopening with its counter intact.
- `npm run check:all` green; baselines are never `--update`d to make a gate
  pass.

### 2.15 Explicitly out of scope

- **Seasons, weather, firewood, heating.** A year exists here only as a unit
  for ages and rates. Nothing cycles.
- **Food variety or nutrition requirements.** Bread and berries already differ
  by what they restore; a variety rule is a second mechanic on the same axis.
- **Families, couples, genders, lineage, inheritance.** §2.6's two-adult rule
  is the whole of the reproduction model.
- **Schools, healthcare, happiness, clothing.**
- **Two-way haul and storage buildings** — still increment 4's named successor,
  still not this.
- **Nomads as arrival events.** The button stays a button; a nomad does not
  show up unbidden with a timer and an accept/decline prompt.
- **Multiple house tiers.** One house def.
- **The tick-interval sync seam** stays deferred (OBS-4-09's note).

---

## 3. Acceptance criteria

1. A colony with surplus food and a free bed produces a child; that child
   cannot be assigned to a building, eats like everyone else, and becomes
   assignable at year 10.
2. An adult reaching year 55 is automatically unassigned from its job with a
   notice, keeps eating, and dies of old age within the spread around year 65 —
   and two colonists of *identical age* but different ids do not die on the
   same tick. (They cannot be born on the same tick — births are cooldown-gated
   colony-wide — so the test seeds equal ages directly.)
3. Cutting a colony's food off drives efficiency down as it already does, then
   raises `starvingTicks`, then kills — with the counter visible on the
   Population view for a full year before the first death.
4. Building a house raises `beds.total`; the next tick homes a homeless
   colonist into it and their work power rises off `homelessFactor`.
   Demolishing it makes its occupants homeless again, and moving it does so for
   the duration of the move.
5. Two identically staffed foresters, one crewed by colonists housed beside it
   and one by colonists housed across the map, deliver measurably different
   amounts over the same run.
6. The nomad button is disabled with the reason naming the failed gate (no bed
   / not enough food / cooldown), and the engine rejects the command with the
   same reason when dispatched anyway.
7. A save written mid-starvation reopens with `starvingTicks` intact; a v4 save
   loads as adults with a starter house placed and its first four colonists
   housed; the v1→v5 chain still runs.
8. `npm run balance:report` prints the population scenario, and increment 5's
   distance/hauler assertions still pass with their existing thresholds.
9. `renderer.ts` is under the 500-line LOC gate without a baseline entry.
10. The README gains an Increment 6 section describing what a player can now
    do, and §4 of this document is rewritten with measured values rather than
    the starting points below.

---

## 4. Balance values

**Starting points, not claims.** Increment 5's thesis was that a constant
justified by prose rather than measurement is a guess; this table records what
the increment starts from, and §4 of this document is to be **rewritten with
what the harness measured** before the increment is called done — including the
outcome "validated, unchanged", which is a legitimate result.

| constant | start | reasoning to be checked |
| --- | ---: | --- |
| `yearTicks` | 100 | Matches `statsWindowTicks`; makes a full generation ~6,500 ticks (~13 min at 4×), so the demographic wave is observable in a session. |
| `matureYears` | 10 | A child is a ten-year investment — long enough to be a real bet, short enough to pay back inside a session. |
| `retireYears` | 55 | With `matureYears`, ~⅓ of a life is dependent. |
| `lifespanYears` | 65 | Ten years of retirement after `retireYears`, so an elder is a visible cost rather than a rounding error. |
| `lifespanSpreadYears` | ±8 | Wide enough to break up synchronised waves without making age unpredictable. |
| `startingAgeYears` | 25 | Founders staggered by the same spread. |
| `nomadArrivalYears` | 20 | Arrives with most of a working life ahead, which is what makes the higher food gate a fair price. |
| `starvationDeathTicks` | 100 | One year pinned at max hunger. |
| `birthFoodPerHead` | 6 meals | ~3 years of food per colonist. |
| `nomadFoodPerHead` | 10 meals | ~5 years — strictly above the birth gate, per §2.7. |
| `birthCooldownTicks` | 50 | Half a year between births, colony-wide. |
| `commutePenaltyPerTick` | 0.04 | A 1-tick walk costs 4%; the map's longest commute reaches the floor. |
| `commuteFloor` | 0.5 | The worst possible housing halves a colonist, never zeroes them. |
| `homelessFactor` | 0.5 | Equal to the commute floor: being homeless is exactly as bad as the worst commute, so the player has one number to beat. |
| `houseBeds` | 4 | Three founders plus one spare, so the opening has a free bed and the second house is the first growth decision. |

The specific questions the harness must answer, rather than the values being
adjusted until they feel right in a browser:

- Does a colony left alone with a working food chain reach a **stable
  population**, or does it oscillate? An oscillation with a period near
  `lifespanYears` is the demographic wave working; an unbounded ramp means
  `birthFoodPerHead` is too low.
- How many ticks of warning does the player get between the first
  `starvingTicks` climbing and the first death, at a realistic colony size?
  Under one autosave interval is too few.
- Is the commute penalty large enough to change a placement decision, and small
  enough that it is not simply always correct to cluster everything at the
  camp — which would reintroduce the exact failure increment 5 §1.2 closed?
