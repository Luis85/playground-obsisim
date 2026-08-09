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
commuteTiles  = euclidean(home, workplace)
charged       = max(0, commuteTiles - commuteFreeTiles)
commuteFactor = max(commuteFloor, 1 - charged * commutePenaltyPerTile)
```

- The **Euclidean measure** is the existing shared one (`haulDistance`'s
  family in `src/shared/placement.ts`), so the cost model still agrees with the
  line the renderer draws — the argument increment 5 §2.3 made for relocation.
- **It charges tiles, not `ticksForDistance`.** That reuse is the obvious move
  and it is wrong here. `ticksForDistance` floors at 1 *by design*, so that no
  placement is ever free and no haul costs nothing. Applied to a commute, that
  floor means every colonist in the game pays the minimum penalty permanently —
  including the balance harness's crews, which would shift every number
  increment 5 measured for a reason that has nothing to do with hauling, in
  breach of §1.3. A commute genuinely *can* be free: you live next door.
- **`commuteFreeTiles` is what makes it free.** Living within that radius of
  your job costs nothing; the penalty ramps beyond it. This is also the better
  rule on its own terms — it rewards siting homes near the work they serve
  without taxing the unavoidable first few tiles.
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

**Each gate divides by the population it would produce, not the current one:**
a birth by `population + 1`, a nomad by `population + 1`. That is the honest
question ("can the store feed them once they are here?"), and it removes what
would otherwise be a special case with a hole in it. Dividing by the *current*
population needs `population === 0` treated as unbounded to avoid a division by
zero — and unbounded satisfies any threshold, so a colony with an **empty
store** and one standing bed could still welcome a nomad, flatly contradicting
§2.7's claim that a colony with no food is unrecoverable. Dividing by
`population + 1` is never zero, needs no special case, and makes the last
survivor's death leave a colony that genuinely cannot restart without food.

### 2.6 Births

A birth spawns a colonist at `Age 0`. All four conditions are required:

1. a free bed exists (equivalently, by §2.3, nobody is homeless);
2. at least **two adults** are alive;
3. `mealsPerHead >= BALANCE.birthFoodPerHead` (per §2.5, over `population + 1`);
4. `BALANCE.birthCooldownTicks` have passed since `SimClock.lastBirthTick`.

**`lastBirthTick` is a new persisted clock field, exactly like
`lastRecruitTick`.** Without it the cooldown has no state to reconstruct from
on load, so reopening a save written just after a birth either grants a free
extra birth immediately or blocks births that should be due — save-and-reload
would change population growth, which is the same defect §2.10 rejects for
`starvingTicks`. It is saved at the top level of the save, not per colonist,
and its fresh-colony sentinel is `-BALANCE.birthCooldownTicks` (matching
`lastRecruitTick`'s).

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
someone — and, because §2.5's gate divides by `population + 1`, one *with an
empty store* cannot. The unrecoverable state is exactly the one the player
could see coming, with the existing reset button as the floor.

### 2.8 The shared population law

A new `src/shared/population.ts`, in the same role `haul.ts` plays for
logistics: the rules as pure exported functions, unit-testable in isolation,
readable by both sides of the seam.

| export | purpose |
| --- | --- |
| `LifeStage` | `'child' \| 'adult' \| 'elder'` |
| `stageOf(ageTicks, bands)` | the band, derived |
| `spreadFor(id, range, salt)` | the id-derived jitter primitive (§2.12) |
| `lifespanFor(id, bands)` | **a lifespan in TICKS** (see below) |
| `commuteFactor(...)` | §2.4 |
| `mealsInStore(...)`, `mealsPerHead(...)` | §2.5 |
| `birthBlocker(...)`, `nomadBlocker(...)` | the failed gate, or `null` |

**Everything age-shaped in this module is in ticks, never years.** Years are a
*display and authoring* unit only: `BALANCE` declares bands in years because
that is how a human reasons about them, and converts once. `Age.ticks` is
compared against a `lifespanFor` that also returns ticks — a `lifespanFor`
returning years would kill colonists around tick 65 instead of year 65, i.e.
before they ever mature, and the types would not catch it because both are
`number`. The conversion happens where the constants are declared, and nothing
downstream ever sees a year.

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

- gives every v4 worker an adult age, staggered by id (§2.12), and
  `starvingTicks: 0`;
- places **the same starter house a fresh colony gets** (§2.11), using the
  existing deterministic auto-placement pattern so a v4 colony that already
  built on that tile gets the next one instead;
- **writes `homeId` for the first `houseBeds` colonists by ascending id**,
  leaving the rest `null`.

That last step is not redundant with §2.9's homing phase. `buildColonyPrepWorld`
seeds the initial snapshot **directly from the save**, and a restored engine is
paused until the player advances it — so a migration that wrote every `homeId`
as null would present a wholly homeless colony, at `homelessFactor` work power,
for as long as the player leaves it paused, contradicting acceptance criterion 7.
Writing the assignment into the save makes the record self-consistent, and the
homing phase then has nothing to do on the first tick rather than silently
repairing the save's own output. It also mirrors what v1→v2 already does:
migrations synthesise the state the new mechanic needs rather than deferring it
to the first tick.

The result puts a migrated colony in exactly a new colony's position: housed up
to `houseBeds`, and building for the rest. There is precedent for deterministic
fabrication at migration — v1→v2 invented every building's position — and the
alternative is a silent penalty on load.

The save also gains a top-level `lastBirthTick` (§2.6). A fresh colony seeds it
to `-BALANCE.birthCooldownTicks`, matching `lastRecruitTick`'s sentinel, but the
**migration writes `0`** — migrations may not import `BALANCE`, and they do not
need to: any migrated colony is already past tick `birthCooldownTicks`, so `0`
and the sentinel are indistinguishable in effect. It is guarded exactly as
`lastRecruitTick` is (a safe integer, not ahead of `tick`).

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
`BALANCE.startingAgeYears`, under a salt distinct from the lifespan draw's, so
the three founders do not die in the same year.

### 2.12 Determinism without randomness

The project has never used an RNG and does not gain one here. But a single
fixed lifespan makes every death an exact copy of a birth `lifespanYears`
earlier: the founders die together, a migrated v4 colony dies together, and a
run of births spaced by `birthCooldownTicks` produces deaths spaced identically
— visibly mechanical, and a demographic wave with no width to it.

One primitive, `spreadFor(id, range, salt)`, derives a jitter from the entity
id: a multiplicative hash of the id mixed with the salt, reduced modulo
`2 * range + 1`, minus `range`. It is pure, uniform over the range, stable
across save/load (ids are already unique and persisted), and needs no seed in
the save. It has three callers: lifespan, starting age (§2.11), and nomad
arrival age (§2.7) — one hash in the codebase rather than three.

**The salt is load-bearing, not decoration.** Founders are created together and
get both their starting age and their lifespan from this primitive. With one
unsalted spread `s` per id, every founder's remaining life is
`(lifespanYears + s) − (startingAgeYears + s)` = a constant — the two jitters
cancel exactly and the founders die on the same tick anyway, which is the
precise outcome §2.11 introduced staggered ages to avoid. Each call site
therefore passes its own salt (`SALT.lifespan`, `SALT.startingAge`,
`SALT.arrivalAge`), so the three draws are independent.

It must be exported and unit-tested for **range** (never outside
`[-range, +range]`), **stability** (same id, same answer, across a
serialize/restore round trip), **distribution** (a run of consecutive ids does
not collapse onto one value, nor alternate between two — the failure mode a
weak hash produces, and one a range test alone passes happily), and
**decorrelation** (over a run of ids, `spreadFor(id, r, A) − spreadFor(id, r, B)`
is not constant — the exact defect the salt exists to prevent, and one that
range, stability, and distribution tests all pass).

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
  haul gradient. Making that true requires one change to the instrument: the
  harness must **house its colonists** — the crew beside their building, the
  haulers beside the camp — so that commute is not a confound. This is the same
  move, for the same reason, as increment 5 §2.1 seeding a large berry stock so
  hunger is not one: the harness measures logistics, so everything that is not
  logistics is held at its neutral value. With `commuteFreeTiles` at 2, an
  adjacent home scores exactly 1.0, so the existing numbers are preserved by
  construction rather than by luck — and the task that lands commute must
  verify that claim by running the increment-5 assertions before and after.
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
7. A save written mid-starvation reopens with `starvingTicks` intact, and one
   written just after a birth reopens still on its birth cooldown; a v4 save
   loads as adults with a starter house placed and its first four colonists
   already homed **in the seeded snapshot, before any tick runs**; the v1→v5
   chain still runs.
8. `npm run balance:report` prints the population scenario, and increment 5's
   distance/hauler assertions still pass with their existing thresholds.
9. `renderer.ts` is under the 500-line LOC gate without a baseline entry.
10. A colony at population 0 with beds standing and an **empty** store cannot
    welcome a nomad; the same colony with food in the store can.
11. The README gains an Increment 6 section describing what a player can now
    do, and §4 of this document is rewritten with measured values rather than
    the starting points below.

### 3.1 Checked at close-out

Every criterion above against what actually shipped, at Task 13. **One fails**,
and it is recorded as failing rather than reworded to fit.

| # | verdict | evidence |
| ---: | --- | --- |
| 1 | **met** | `births a child when fed and housed…`; children are excluded from `idleAdults` (`snapshot-builder.ts`) and from both assign handlers' idle scan, and the assign buttons disable on `idleAdults === 0`; `HungerSystem` queries `Hunger` with no stage filter, so a child eats a full ration; `stageOf`'s boundary test pins year 10 as the first adult tick |
| 2 | **met** | `retires an adult who crosses the elder band, freeing its job slot`; `kills a colonist who reaches its own lifespan, not a shared one` |
| 3 | **FAILS, narrowly** | the counter is visible for **99 ticks**, not the full year the criterion asks for. See below |
| 4 | **met, and exceeded** | homing lands on the build tick, not "the next tick": `houses a homeless colonist on the tick its house is built, not the tick after`, `charges a colonist housed by a same-tick construction as housed, not homeless`, `makes a demolished house homeless immediately, not next tick`, `re-homes an evicted colonist once its relocating house lands` |
| 5 | **met** | measured 264 vs 130 delivered (§4.1 q3) |
| 6 | **met, by construction** | `NOMAD_REJECTIONS` is a single exported record imported by both `PopulationView.vue` and `command-handlers.ts`, so the button's reason and the engine's rejection are the same string, not two strings kept in step |
| 7 | **met** | `round-trips a mid-starvation, mid-cooldown colony`; `v4 -> v5: colonists become adults, a starter house appears, and its beds are already assigned`; `a migrated colony is housed in the SEEDED snapshot, before any tick runs`; `migrates a v1 save all the way to the latest version in one call` |
| 8 | **met** | `npm run balance:report` prints three population curves beside the sweep; all 16 sweep rows are byte-identical to increment 5's, and the four distance/hauler assertions pass at their existing thresholds |
| 9 | **met** | `renderer.ts` is 445 non-blank lines, and appears in neither `loc-baseline.json` nor `quality-baseline.json`. The split §2.13 planned for was not needed and was dropped, as that section allowed |
| 10 | **met** | `refuses a nomad to a wiped-out colony with an empty store` |
| 11 | **met** | this document's §3.1 and §4, and the README's Increment 6 section |

**Why 3 fails.** It asks for the starvation counter to be "visible on the
Population view for a full year before the first death". A year is 100 ticks;
the measured window is 99 (§4.1 q2). It is a fencepost — the tick the counter
*reaches* `starvationDeathTicks` is the tick the colonist dies on, so the last
snapshot a player can still act on is one earlier — and the wider slide from a
colony's last meal to its first death is ~199 ticks, or two autosave intervals.
The criterion is still not met as written, and `starvationDeathTicks` was left
at 100 rather than raised to 101 to buy the word "full": a constant should move
because of a measurement, not because of an adjective.

**What no criterion covered, and should have.** None of the eleven asks whether
a colony left alone *survives*. §4.1 q1 measures that it does not — a
self-feeding colony overshoots its chain and goes extinct. Task 12's own brief
proposed `finalOf(roomy).adults + finalOf(roomy).children > 4` as an assertion;
it does not hold, and no `BALANCE` constant was changed to make it hold. That
gap between "every acceptance criterion passes" and "the game works" is the
most useful thing this increment learned about its own criteria.

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
| `commuteFreeTiles` | 2 | Living next door to your job is free — and, per §2.4, this is what keeps increment 5's measurements from shifting under a floor they never paid. |
| `commutePenaltyPerTile` | 0.03 | Distance 10 costs ~24%; the floor arrives around distance 19, well inside the default map but only for genuinely bad siting. |
| `commuteFloor` | 0.5 | The worst possible housing halves a colonist, never zeroes them. |
| `homelessFactor` | 0.5 | Equal to the commute floor: being homeless is exactly as bad as the worst commute, so the player has one number to beat. |
| `houseBeds` | 4 | Three founders plus one spare, so the opening has a free bed and the second house is the first growth decision. |

### 4.1 What the harness measured

Task 12 built the instrument (`tests/support/population-harness.ts`,
`runPopulationScenario`) and ran the three questions above. Reproduce any of
this with `npm run balance:population`. **No constant in the table above was
changed.** Two of the three questions came back clean; the first did not, and
what it returned is recorded here rather than tuned away.

**1. Does a colony left alone with a working food chain reach a stable
population, or does it oscillate?**

**Neither. It overshoots and dies.** Twelve houses (48 beds), two gatherers'
huts, two haulers, four founders, 12,000 ticks, the colony feeding itself:

| tick | 1,000 | 2,200 | 3,200 | 5,200 | 7,000 | 7,800 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| population | 22 | **41** | 41 | 41 | 27 | **0** |
| meals/head | 6.0 | 5.7 | 4.1 | 0.1 | 6.9 | – |

44 births, 24 deaths of old age, **24 starvation deaths**, extinct by tick
7,800.

The ceiling is genuinely food and not housing — 41 against 48 beds — and it is
the chain *producing*, not the harness under-hauling: adding a third hauler
does not move the peak, while cutting `haulCarryCapacity` to 1 moves it by 8.
A one-house control takes 0 births and 0 starvation deaths, so beds gate births
exactly as §2.6 says.

The mechanism is that **`birthFoodPerHead` is a stock test, not a flow test.**
`mealsPerHead` measures what is in the store; a young colony banks that faster
than it eats, so births continue past the population the chain can feed. The
store then drains (meals/head 5.7 → 0.1 over 3,000 ticks), births stop for
longer than a maturity span, and the age pyramid empties from the bottom. When
the single synchronised cohort retires — from tick 4,600 onward — there is
nobody behind it, production stops, and the colony starves.

So the diagnosis the table above anticipated — "an unbounded ramp means
`birthFoodPerHead` is too low" — is half right. The ramp is bounded, by
starvation. Raising `birthFoodPerHead` would delay the overshoot without
removing it, because no value of a store threshold answers "is there work for
this colonist". The candidate fixes, for a later increment to choose between:

- gate births on `netFlow` for edibles as well as on stock, so a colony that is
  eating into its store stops breeding before the store is gone;
- or gate on idle adults, so a colony with no work for its people stops making
  more of them.

Neither is a constant change, which is why nothing in the table moved.

**2. How many ticks of warning between `starvingTicks` climbing and the first
death?**

**99 ticks — one short of the `autosaveEveryTicks` bar this section set.**
Measured at tick resolution: the countdown starts at tick 100 (hunger reaches
`hungerMax`) and the first death lands at tick 199.

This is a fencepost, not a tuning error. A colonist is pinned at max hunger for
the whole of `starvationDeathTicks`, but the tick the counter *reaches* the
limit is the tick they die on, so the last snapshot a player can still act on is
one earlier. `starvationDeathTicks` stays at 100. Note that the window measures
99 only when sampled every tick; the first draft of this measurement sampled
every ten ticks and reported exactly 100, clearing its own bar on a rounding
artefact.

The whole slide is much longer than the countdown — hunger has to climb from 0
to `hungerMax` before the countdown starts at all — so a player watching the
Population view has ~199 ticks, or two autosave intervals, from a colony's last
meal to its first death.

**3. Is the commute penalty large enough to change a placement decision, and
small enough that clustering is not simply always right?**

**Yes to both, and it shows up in delivered goods rather than only in a unit
test of `commuteFactor`.** Two runs of the same forester with the same crew and
haulers, differing only in where the crew sleeps:

| measurement | delivered | ratio |
| --- | ---: | ---: |
| forester at (6,5), crew housed adjacent | 264 | – |
| forester at (6,5), crew housed at (22,15) | 130 | 0.49 |
| forester at (20,13), crew housed on site | 384 | – |
| forester at (20,13), crew housed beside the camp | 195 | 0.51 |

A bad commute halves a crew, which is `commuteFloor` doing exactly what it says.
And the second pair is the half that matters for §1.2: housing beside a distant
producer beats housing at the camp by 1.9x, so "cluster everything at the camp"
is a real decision with a real cost, not a dominant strategy.

### 4.2 Not a balance value, but found while measuring

`OBS-6-02`: two colonists dying on the same tick freeze the simulation for one
tick each — sim-ecs 0.6.4 throws inside `removeEntity` on the second removal of
a batch, swallows the error, and drains the rest one per step with no system
running. It distorts any per-tick tally taken from `SnapshotStore.latest`, which
is how it was found. See `docs/issues/`.

A third consequence, verified at close-out and added to the note: the autosave
fires on `clock.tick % autosaveEveryTicks` **inside `runStep`**, and the clock
increments on frozen steps like any other, so a save can land mid-freeze holding
colonists who are logically dead. That save is structurally valid and loads
cleanly; those colonists then die on the first tick after the reload. It is the
same principle this increment enforced twice already — **the seed must not
advertise a state tick 1 revokes** — arriving from a third direction, after the
homing phase and the past-own-lifespan restore guard.

**How much it distorted §4.1: none, this time.** Every curve above reports
`frozen steps 0`, so the tick labels are exact. Deaths in these runs never
coincided, because §2.12's id-derived lifespan spread desynchronises them — the
primitive introduced to widen the demographic wave also happens to keep this
defect from firing. That is luck, not protection: a narrower spread, a
synchronised famine, or a retune of `lifespanSpreadYears` would collide deaths
and inflate every tick label by the total frozen ticks. `runPopulationScenario`
publishes `frozenSteps` on every curve precisely so that a future run cannot
inflate its numbers quietly, and **any re-measurement must check it is still 0
before quoting a tick.**

### 4.3 Two fixtures that hold their conclusions by margin, not by assertion

Neither of these is unguarded — both carry two-sided vacuity bounds, and a
retune that pushed either run out of its intended regime would fail loudly
rather than quietly. What is *not* asserted in either case is the **margin** the
prose conclusion actually rests on. They are recorded so that a future retune
re-reads the conclusion rather than only the green tick.

**The chain test's `huts: 2`.** `a colony feeding itself is capped by its FOOD
CHAIN…` brackets the peak on both sides: `> startingAdults * 4` (16) so a colony
that never grew cannot pass, and `< ROOMY_HOUSES * houseBeds` (48) so a housing
plateau cannot pass. At **4** huts the chain out-produces 48 beds and the upper
bound fails at exactly 48, so the fixture choice is defended.

The gap is between the assertion and the claim. The assertion is `peak < 48`;
the claim §4.1 draws from it is *"the ceiling is genuinely food and not
housing"*, and that needs **room** below 48, not merely a value below it. Today
the peak is 41 — seven colonists of headroom. At 47 the assertion would still be
green while the colony was effectively bed-capped and the paragraph above it
false. Anything that moves food supply or demand against bed supply narrows that
headroom: `houseBeds`, the hunger rate, `mealThreshold`, the gatherers' hut
recipe or its `workerSlots`. **After any such retune, re-read the peak against
the bed count rather than only checking the suite is green**, and confirm the
one-house control still takes 0 births — those two together are what make the
run a measurement of food rather than of beds.

**The housing property test's periods.** `never over-houses, admits an arrival
it has no bed for, or ends a tick it cannot reload` drives churn on three
coprime periods — construct every 61, relocate every 23, demolish every 101 —
deliberately *below* what the two arrival cooldowns (30 and 50) could admit, so
the colony spends most of the run with no spare bed. That saturated regime is
the only one in which the admission gates decide anything; the predecessor of
this test passed under a broken `spareBeds` precisely because beds were going
spare.

This is guarded, and well: the run must reach `joined > 5`, `moved > 5`,
`demolished > 2` and `saturated > 100` of 600 ticks, against actuals of
12 / 26 / 5 / **412**. A retune that made the colony comfortable would trip the
saturation bound.

The residual risk is narrower than "it stops being saturated", and it is that
**reaching a state is not the same as the assertions discriminating inside it**.
`saturated` counts ticks where `beds.total <= population`; it does not check
that an arrival and a churn command ever contended for the *same* bed in the
same drain, which is the interaction `4012dd2` was about and the thing the
coprime periods exist to produce. A change to `birthCooldownTicks`, the recruit
cooldown, or `houseBeds` could keep saturation at 400 while the phases realigned
so that contention stopped happening. **The honest safeguard after such a retune
is to re-run the mutations that originally falsified this test** — drop
`pending.arrivals.length` from `spareBeds`, and disable the relocation eviction
— and confirm each still turns it red.
