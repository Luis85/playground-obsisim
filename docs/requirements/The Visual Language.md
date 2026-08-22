---
type: PBI
parent: "[[The World Screen]]"
order: 50
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The Visual Language

One palette drives both renderers. `src/app/world/theme.ts` already resolved a rigorous colour language (red/orange/green for building state, purple for the output-full stall, cream for tools and batch progress, cyan for in-transit, brown for depot stock) from Obsidian CSS variables through a `VarReader`; the HTML chrome now reads the same custom properties on `.obsisim`, so a `waitingForInput` row in Attention is the exact orange of the ring on that building, by construction, rather than two lists that agree by hand. Every ticking number carries `font-variant-numeric: tabular-nums` so digits stop jittering as values change, across a three-step type scale (vitals, body, caption). Chrome iconography outside the canvas legend is an inline SVG sprite rather than emoji, since emoji cannot take `currentColor` and `src/app/` deliberately never imports `obsidian` (which rules out Lucide's `setIcon`). Three named transitions — dock panel enter/leave, attention row appear, vitals value-change flash — all respect `prefers-reduced-motion`. No `!important`; `check:css`'s baseline stays empty.

Spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md` §2.9
