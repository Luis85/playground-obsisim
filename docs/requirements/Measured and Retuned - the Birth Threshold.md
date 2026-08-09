---
type: PBI
parent: "[[Survival and Population]]"
order: 80
status: Done
tags:
  - game-design
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Measured and Retuned - the Birth Threshold

`npm run balance:population` runs a colony feeding itself for 12,000 ticks. At the threshold this increment first shipped, the colony overshot what its chain could feed and was extinct by tick 7,800; `birthFoodPerHead` moved 6 to 12 (and `nomadFoodPerHead` 10 to 20 with it). The same run now holds 34-40 colonists through two full generations with nobody starving. The harness staffs buildings but cannot build them, so the number is a floor: a player who keeps extending the food chain survived even at the old value.

Spec: `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md` §4.1
