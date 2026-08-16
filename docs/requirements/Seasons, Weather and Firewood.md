---
type: Feature
parent: "[[Population and Survival]]"
order: 20
status: New
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Seasons, Weather and Firewood

The colony's year has no shape. `BALANCE.yearTicks` exists and is read only by the life bands — a colonist ages through it — so a year is a unit of lifespan and nothing else. Production is flat, hunger is flat, and a colony that survives its first hundred ticks survives indefinitely at the same rate. There is no season in which a farm yields less, no winter to stockpile against, and no reason to hold a surplus rather than spend it.

**Filed late, and the lateness is the point of this paragraph.** Increment 6 deferred it, and increment 7 §2.13 named it "the strongest candidate for increment 9" — but unlike every other deferral in that section, no backlog note was written. Roads, storehouse-to-storehouse transfer and construction-as-work all got one; this did not, and it survived only as a clause in a shipped spec's out-of-scope list, where nothing would have surfaced it when increment 9 was chosen. It is filed now for that reason rather than because it is next.

## Why it is the strongest candidate for a survival increment

Every mechanic the game has built so far is a *rate*: goods per tick, meals per head, planks per hauler. Nothing yet makes a **stock** valuable, and a colony sim's characteristic decision — spend now or keep for later — does not exist until something does. A winter in which food production stops and warmth must be paid for is the smallest mechanic that creates it.

It also gives three shipped systems something to bite on that they currently lack:

- **The storehouse** (increment 7) is measured as a logistics buffer. A depot that holds a winter's food near a distant cluster is a different and larger argument for it than the pipeline-stage one increment 8 measured, and it is the first case where *what* a depot holds matters rather than only how much.
- **The birth and nomad food gates** (increment 6) read a stock that only ever grows. Against a seasonal drawdown they become a real throttle rather than an early-game one.
- **The hunger and starvation clock** has never been under sustained pressure — every balance fixture seeds `berries` at `FED` precisely so it stays neutral. A winter is the first thing that would exercise it as designed, and `BalanceResult.deaths` already notes that it counts starvation and old age together and would need splitting when that day comes.

## What it would take

- A **season clock** derived from `SimClock` and `yearTicks` — derived, not stored, so it needs no save field and cannot drift from the tick count.
- A per-season **yield multiplier** on recipes, or on a subset of them. A farm that yields nothing in winter is the sharp version; a farm that yields less is the tunable one.
- **Firewood**: a resource, a consumer (households rather than workplaces), and a production chain that already half-exists — `forester` makes wood and nothing yet burns it.
- A **warmth** need beside hunger, with the same shape: a per-tick drain, a threshold below which efficiency falls, and a death clock. Increment 6's hunger is the template and the argument for reusing its shape rather than inventing a second one.
- Balance work that is larger than the code: a winter long enough to matter and short enough to survive is a measurement, and the balance harness currently has no fixture that runs a colony against a *deadline*.

## What it must not do

- **Not a second hunger.** If warmth is hunger with a different resource name, it doubles the bookkeeping and adds no decision. What makes it different has to be that firewood competes with *planks* for the same wood, so heating the colony and building it are the same budget.
- **Not a difficulty setting.** A season that merely scales every rate down is a slower game, not a harder one. The decision it must create is *when to stop producing and start storing*.

## Documentation

- `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md` — hunger, the starvation clock, and the life bands that already consume `yearTicks`
- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.13 — where this was named and not filed
- See also: [[Survival and Population]], [[Storehouses - a Second Place to Put Things]]
