# Increment 11 — The World Screen: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canvas the way the colony is played — every engine verb reachable from one world screen, with the tables demoted to a Ledger fallback.

**Architecture:** `src/app/` is restructured around a single world screen. A new `ui-store` holds selection, dock panel and interaction mode as one authoritative unit; `WorldStage` owns the canvas and forwards that state through the widened `WorldRenderer` seam; `WorldScreen` composes rail, stage, dock and resource strip. The router drops to two routes (`/`, `/ledger`). No engine or shared code changes at all.

**Tech Stack:** Vue 3 (`<script setup lang="ts">`), Pinia, vue-router (memory history), Excalibur 0.32 behind an injected factory seam, Vitest + happy-dom + `@vue/test-utils` + `@pinia/testing`.

**Spec:** `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md`

## Global Constraints

- **No engine or shared changes.** `git diff --stat <increment-10 merge base>...HEAD -- src/engine src/shared` must be empty (spec criterion 12). No new command, snapshot field, save version or balance constant.
- **Every `src/` file at or under 500 nonblank lines.** `scripts/loc-baseline.json` is `maxLoc: 500` with an empty `files` map — no exemptions. Check with `npm run check:loc`.
- **No `!important` in CSS.** `scripts/css-important-baseline.json` has an empty `files` map; `npm run check:css` enforces it.
- **Tests never import the real Excalibur renderer.** `src/app/world/renderer.ts` touches `window` at module scope and takes seconds under happy-dom. Every app test injects a fake through `WORLD_RENDERER_KEY`. `renderer.ts` is verified by `npm run smoke:world` and by `vue-tsc`, never by unit tests.
- **Presentation lives in `src/app/labels.ts`,** not in templates. Records keyed by a union (`BUILDING_STATE_LABELS`, `LIFE_STAGE_LABELS`) so a new union member is a compile error rather than a raw string in a cell.
- **`src/app/` never imports `obsidian`.** Only `src/view/` and `src/main.ts` do. This is what keeps the app layer mountable in jsdom/happy-dom.
- **Two surfaces per verb.** Every control added to the world screen gets a plain equivalent in the Ledger (Task 12).
- **Commit after every task.** Run `npm test` before each commit; `npm run check:all` before the final one.

### Architectural note: where the interaction mode lives

Spec §2.6 assigns the mode machine to `world/interaction.ts` and selection to `ui-store`. Spec §2.1 requires the cancel-on-change invariant to live in the store's selection setter. Those pull in opposite directions, so this plan resolves it: **`ui-store` owns the authoritative `mode` state alongside `selection` and `panel`**, and `interaction.ts` is the composable that wraps that state with ghost computation, tile validation and pointer handlers. The invariant stays in one place; `interaction.ts` stays testable with no DOM. Task 1 and Task 4 implement the two halves.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `src/app/stores/ui-store.ts` | `Selection`, dock panel, interaction mode, highlight set, narrow flag; the cancel invariant and the Escape ladder |
| `src/app/world/interaction.ts` | Ghost preview, tile validation, canvas pointer handlers — composable over `ui-store` |
| `src/app/views/WorldScreen.vue` | The shell: rail, stage, dock, resource strip, Escape listener, `ResizeObserver` |
| `src/app/views/WorldStage.vue` | Canvas host: renderer lifecycle, snapshot sync, hover tooltip, forwarding selection and highlight |
| `src/app/views/LedgerView.vue` | Composes the four table views; owns no figures |
| `src/app/components/dock/InspectorPanel.vue` | Selected building or colonist, with staffing / move / demolish |
| `src/app/components/dock/ColonyPanel.vue` | The full resource table |
| `src/app/components/dock/PopulationPanel.vue` | Stage counts, colonist rows, Welcome a nomad |
| `src/app/components/dock/EconomyPanel.vue` | Chains, backlogs, stage rows |
| `src/app/components/dock/AttentionPanel.vue` | The problem list |
| `src/app/components/ResourceStrip.vue` | Stock with runway colouring; hauler assign/unassign |
| `src/app/components/Icon.vue` | Inline SVG sprite lookup |
| `src/app/icons.ts` | The sprite: `Record<IconName, string>` of path data |
| `tests/app/ui-store.test.ts`, `tests/app/attention.test.ts`, `tests/app/interaction.test.ts`, `tests/app/world-screen.test.ts`, `tests/app/world-stage.test.ts`, `tests/app/dock-panels.test.ts`, `tests/app/ledger-view.test.ts`, `tests/app/resource-strip.test.ts` | Per-unit tests |

**Modified**

| File | Change |
| --- | --- |
| `src/app/stores/game-store.ts` | Add the Attention derivations (Task 2) |
| `src/app/world/renderer-key.ts` | Widen `WorldRenderer`: `setSelection(Selection)`, `setHighlight` |
| `src/app/world/renderer.ts` | Colonist selection ring, highlight pulse. **No camera change** — see OBS-11-01 |
| `src/app/router.ts` | Five routes → two |
| `src/app/App.vue` | Nav strip removed; keep-alive retained for the world route |
| `src/app/views/WorldView.vue` | **Deleted** — split into `WorldScreen` + `WorldStage` + `interaction.ts` |
| `src/app/components/SelectionPanel.vue` | **Deleted** — becomes `InspectorPanel` |
| `src/app/views/BuildingsView.vue` | Gains a Move control (Ledger parity) |
| `src/app/views/DashboardView.vue`, `PopulationView.vue`, `EconomyView.vue` | Keep their tables, lose their routes |
| `styles.css` | Palette tokens, layout, type scale, motion |
| `src/app/world/theme.ts` | Read the new CSS custom properties |
| `vitest.config.ts` | Coverage floors for components and views |
| `README.md` | Increments 8–10; rewrite the no-WebGL sentence |
| `docs/requirements/` | New epic, feature and PBIs; supersede Table Parity |

---

## Task 1: `ui-store` — selection, dock, mode, and the invariant

Everything else consumes this. It lives in `src/app/stores/`, which already carries a 90/85/90/90 coverage floor, so the invariant is gated automatically.

**Files:**
- Create: `src/app/stores/ui-store.ts`
- Test: `tests/app/ui-store.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type Selection = { kind: 'building'; id: number } | { kind: 'colonist'; id: number } | { kind: 'none' }`
  - `type DockPanel = 'inspector' | 'colony' | 'population' | 'economy' | 'attention'`
  - `type Mode = { kind: 'idle' } | { kind: 'place'; defId: BuildingDefId } | { kind: 'move'; buildingId: number }`
  - `useUiStore()` with state `selection`, `panel: DockPanel | null`, `mode`, `highlight: Selection[]`, `narrow: boolean`
  - actions `select(next: Selection)`, `selectBuilding(id)`, `selectColonist(id)`, `clearSelection()`, `openPanel(p)`, `closeDock()`, `armPlace(defId)`, `armMove(buildingId)`, `cancelMode()`, `setHighlight(subjects)`, `setNarrow(flag)`, `reportRendererFailure(message)`, `escape(): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/app/ui-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useUiStore } from '../../src/app/stores/ui-store';

describe('ui-store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('auto-opens the inspector when a building is selected', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    expect(ui.selection).toEqual({ kind: 'building', id: 7 });
    expect(ui.panel).toBe('inspector');
  });

  it('keeps the selection when the dock switches panel', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.openPanel('attention');
    expect(ui.selection).toEqual({ kind: 'building', id: 7 });
    expect(ui.panel).toBe('attention');
  });

  // The five routes of spec §2.1's invariant. Each one arms a move and then
  // takes a different path away from it; none may leave mode armed.
  it('cancels an armed move when the selection is cleared', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.clearSelection();
    expect(ui.mode).toEqual({ kind: 'idle' });
  });

  it('cancels an armed move when the selection is REPLACED by a colonist', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.selectColonist(3); // non-none: fails a rule written as "cleared to none"
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'colonist', id: 3 });
  });

  it('cancels an armed move when the selection is replaced by another building', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.selectBuilding(9);
    expect(ui.mode).toEqual({ kind: 'idle' });
  });

  it('cancels an armed move when the dock switches panel, keeping the selection', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.openPanel('attention'); // never touches the selection setter
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'building', id: 7 });
  });

  it('cancels an armed move when the dock is closed', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.closeDock();
    expect(ui.mode).toEqual({ kind: 'idle' });
  });

  it('re-selecting the SAME building does not cancel its own armed move', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.selectBuilding(7);
    expect(ui.mode).toEqual({ kind: 'move', buildingId: 7 });
  });

  // Escape is most-transient-first: mode, then selection, then dock.
  it('unwinds Escape mode-first, then selection, then dock', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);

    expect(ui.escape()).toBe(true);
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'building', id: 7 });
    expect(ui.panel).toBe('inspector');

    expect(ui.escape()).toBe(true);
    expect(ui.selection).toEqual({ kind: 'none' });
    expect(ui.panel).toBe('inspector');

    expect(ui.escape()).toBe(true);
    expect(ui.panel).toBe(null);

    expect(ui.escape()).toBe(false); // nothing left to unwind
  });

  it('records a renderer failure for the app shell to act on', () => {
    const ui = useUiStore();
    expect(ui.rendererFailure).toBe(null);
    ui.reportRendererFailure('no webgl');
    expect(ui.rendererFailure).toBe('no webgl');
  });

  it('arming a place mode clears the selection', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armPlace('farm');
    expect(ui.selection).toEqual({ kind: 'none' });
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/ui-store.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/app/stores/ui-store"`.

- [ ] **Step 3: Write the store**

Create `src/app/stores/ui-store.ts`:

```ts
import { defineStore } from 'pinia';
import type { BuildingDefId } from '../../shared/content-types';

/**
 * What the canvas can have picked out. Discriminated rather than a bare
 * building id (spec §2.3): Population rows and a house's occupant rows name
 * colonists, and a rule that only understands buildings cannot express them.
 */
export type Selection =
  | { kind: 'building'; id: number }
  | { kind: 'colonist'; id: number }
  | { kind: 'none' };

export type DockPanel = 'inspector' | 'colony' | 'population' | 'economy' | 'attention';

export type Mode =
  | { kind: 'idle' }
  | { kind: 'place'; defId: BuildingDefId }
  | { kind: 'move'; buildingId: number };

/** The building an armed move belongs to, or null when nothing is armed. */
function movedBuilding(mode: Mode): number | null {
  return mode.kind === 'move' ? mode.buildingId : null;
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    selection: { kind: 'none' } as Selection,
    panel: null as DockPanel | null,
    mode: { kind: 'idle' } as Mode,
    /** Subjects pulsing from a plural row click (§2.3). Not a selection — and
     * `Selection[]` rather than building ids, because the plural Attention rows
     * name COLONISTS ("3 colonists have no bed"), which a building-id array
     * cannot express. */
    highlight: [] as Selection[],
    /** Set by WorldScreen's ResizeObserver; drives the overlay layout (§2.1). */
    narrow: false,
    /**
     * A renderer failure, boot or post-boot. Store state rather than an emitted
     * event because the component that learns about it is rendered by the
     * ROUTER: `App.vue` has no template handle on a `<router-view>` child, so an
     * `emit('fatal')` from WorldScreen would reach nobody, and §2.5's "the app
     * switches to the Ledger and says why" would never fire.
     */
    rendererFailure: null as string | null,
  }),
  actions: {
    /**
     * The one gate every selection change passes through, and therefore the
     * only place spec §2.1's invariant needs to be written.
     *
     * The condition is on the OUTGOING value, not the incoming one: an
     * Inspector occupant row replaces a building selection with a colonist
     * selection, which is not `none`, and a rule phrased as "cleared" would
     * leave the old building armed with nothing visibly selected.
     */
    select(next: Selection) {
      const armed = movedBuilding(this.mode);
      const stillArmed = armed !== null && next.kind === 'building' && next.id === armed;
      if (armed !== null && !stillArmed) this.mode = { kind: 'idle' };
      this.selection = next;
      if (next.kind !== 'none') this.panel = 'inspector';
    },
    selectBuilding(id: number) { this.select({ kind: 'building', id }); },
    selectColonist(id: number) { this.select({ kind: 'colonist', id }); },
    clearSelection() { this.select({ kind: 'none' }); },

    /**
     * Switching panel keeps the selection (§2.1's dock rule) and therefore
     * cannot ride on `select` above — but it does dismiss the Inspector, and
     * an armed move must not outlive the Inspector that armed it.
     */
    openPanel(panel: DockPanel) {
      if (panel !== this.panel) this.mode = { kind: 'idle' };
      this.panel = panel;
    },
    closeDock() {
      this.mode = { kind: 'idle' };
      this.panel = null;
    },

    armPlace(defId: BuildingDefId) {
      // A selection under an armed palette would double-claim canvas clicks.
      this.select({ kind: 'none' });
      this.mode = { kind: 'place', defId };
    },
    armMove(buildingId: number) { this.mode = { kind: 'move', buildingId }; },
    cancelMode() { this.mode = { kind: 'idle' }; },

    setHighlight(subjects: Selection[]) { this.highlight = subjects; },
    setNarrow(flag: boolean) { this.narrow = flag; },
    reportRendererFailure(message: string) { this.rendererFailure = message; },

    /**
     * One rung of the Escape ladder, most transient first. Returns whether
     * anything was unwound, so the caller knows whether to consume the event.
     */
    escape(): boolean {
      if (this.mode.kind !== 'idle') { this.mode = { kind: 'idle' }; return true; }
      if (this.selection.kind !== 'none') { this.clearSelection(); return true; }
      if (this.panel !== null) { this.panel = null; return true; }
      return false;
    },
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/app/ui-store.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/ui-store.ts tests/app/ui-store.test.ts
git commit -m "The UI store, and the one place an armed move can be cancelled"
```

---

## Task 2: Attention derivations in `game-store`

Spec §2.4: these live in the store, not in the panel, because `src/app/stores/**` is the only app path with a coverage floor today.

**Files:**
- Modify: `src/app/stores/game-store.ts`
- Test: `tests/app/attention.test.ts`

**Interfaces:**
- Consumes: `Selection` from Task 1 (for `subject`).
- Produces: getter `attention: AttentionRow[]` where
  `interface AttentionRow { id: string; severity: 'warn' | 'danger'; message: string; subject: Selection | null; highlight: Selection[] }`

- [ ] **Step 1: Write the failing tests**

Create `tests/app/attention.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot, makeWorker, stockedWith } from './fixtures';

function ingest(overrides = {}) {
  const store = useGameStore();
  store.ingest(makeSnapshot(overrides), { paused: false, speed: 1, error: null });
  return store;
}

describe('game-store attention', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('names a stalled building and selects it', () => {
    const store = ingest({ buildings: [makeBuilding(4, { defId: 'sawmill', state: 'outputFull' })] });
    const row = store.attention.find((r) => r.message.includes('nothing is collecting'));
    expect(row).toBeDefined();
    expect(row!.subject).toEqual({ kind: 'building', id: 4 });
  });

  it('names a building with nothing to work with', () => {
    const store = ingest({ buildings: [makeBuilding(5, { defId: 'bakery', state: 'waitingForInput' })] });
    expect(store.attention.some((r) => r.message.includes('nothing to work with'))).toBe(true);
  });

  it('names a staffable building with nobody on it', () => {
    const store = ingest({ buildings: [makeBuilding(6, { workers: 0, workerSlots: 3, state: 'unstaffed' })] });
    expect(store.attention.some((r) => r.message.includes('no one working it'))).toBe(true);
  });

  // A site keeps its def's workerSlots and has zero workers, but
  // handleAssignWorker refuses a site outright — so an unstaffed row here
  // would report a problem with no fix, beside the materials row that has one.
  it('does not call a construction site unstaffed', () => {
    const store = ingest({
      buildings: [makeBuilding(6, { workers: 0, workerSlots: 3, state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    });
    expect(store.attention.some((r) => r.message.includes('no one working it'))).toBe(false);
    expect(store.attention.some((r) => r.message.includes('needs 5 Wood'))).toBe(true);
  });

  it('names what a site still needs', () => {
    const store = ingest({
      buildings: [makeBuilding(7, { state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 14 } })],
    });
    expect(store.attention.some((r) => r.message.includes('needs 14 Wood'))).toBe(true);
  });

  it('names a runway at or under 30 ticks, and carries no subject', () => {
    const store = ingest({
      stockpile: { ...stockedWith({ bread: 60 }), bread: { stock: 60, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    });
    const row = store.attention.find((r) => r.message.includes('empties in'));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(null);   // a resource has no subject on the map
    expect(row!.highlight).toEqual([]);
  });

  it('groups homeless colonists into one row that pulses them and selects nothing', () => {
    const store = ingest({
      homeless: 2,
      colonists: [makeWorker(1, { homeId: 4 }), makeWorker(2), makeWorker(3)],
    });
    const row = store.attention.find((r) => r.message.includes('no bed'));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(null);
    expect(row!.highlight).toEqual([{ kind: 'colonist', id: 2 }, { kind: 'colonist', id: 3 }]);
  });

  it('is empty for a colony with nothing wrong', () => {
    const store = ingest({ buildings: [makeBuilding(1, { workers: 2, workerSlots: 2, state: 'producing' })] });
    expect(store.attention).toEqual([]);
  });

  it('gives every row a stable unique id', () => {
    const store = ingest({
      buildings: [
        makeBuilding(1, { state: 'outputFull' }),
        makeBuilding(2, { state: 'waitingForInput' }),
      ],
    });
    const ids = store.attention.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/attention.test.ts`
Expected: FAIL — `store.attention` is undefined.

- [ ] **Step 3: Add the getter**

In `src/app/stores/game-store.ts`, add the import and the interface near the top:

```ts
import type { Selection } from './ui-store';
import { needsLabel } from '../labels';

/**
 * One line of the Attention panel. Every field is derived from a Snapshot
 * field that already exists — this increment adds no engine data (spec §2.4).
 *
 * `subject` is what a click selects and `highlight` what it pulses; a row may
 * have neither, which is how a resource row stays inert (§2.3's table) rather
 * than quietly doing nothing by accident.
 */
export interface AttentionRow {
  id: string;
  severity: 'warn' | 'danger';
  message: string;
  subject: Selection | null;
  highlight: Selection[];
}

/** Ticks of runway at or below which a resource is worth naming. The same 30
 * DashboardView already colours a runway cell at — one number, not two. */
const RUNWAY_WARN_TICKS = 30;
```

Add to `getters`:

```ts
    /**
     * The problem list, newest concern first by severity then by kind. Pure
     * derivation over the current snapshot: nothing here is remembered
     * between ticks, so a fixed problem leaves the list by itself.
     */
    attention(state): AttentionRow[] {
      const snapshot = state.snapshot;
      if (!snapshot) return [];
      // A row is EITHER a subject or a highlight set, never both: §2.3's table
      // gives single-building rows a selection and reserves the pulse for the
      // plural rows. Carrying both would make one click do two things and blur
      // the distinction the table exists to draw.
      const rows: AttentionRow[] = [];
      const name = (defId: BuildingDefId) => BUILDINGS[defId].name;

      for (const b of snapshot.buildings) {
        const subject: Selection = { kind: 'building', id: b.id };
        if (b.state === 'outputFull') {
          rows.push({ id: `full-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} is full — nothing is collecting from it` });
        }
        if (b.state === 'waitingForInput') {
          rows.push({ id: `starved-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} has nothing to work with` });
        }
        // The engine's own verdict, not a re-derivation of it. `workers === 0
        // && workerSlots > 0` also fires for every unfinished producer — a site
        // keeps its def's slots — and `handleAssignWorker` refuses a site, so
        // that predicate reports a problem the player cannot fix. The
        // `unstaffed` state already excludes sites, which read
        // `underConstruction`.
        if (b.state === 'unstaffed') {
          rows.push({ id: `unstaffed-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} has no one working it` });
        }
        if (Object.keys(b.constructionNeeds).length > 0) {
          rows.push({ id: `site-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} site needs ${needsLabel(b.constructionNeeds)}` });
        }
      }

      // Resource rows carry neither a subject nor a highlight: a resource is
      // not a thing on the map, and §2.3 keeps that inert in both panels.
      for (const [id, ticks] of Object.entries(this.runways as Partial<Record<ResourceId, number>>)) {
        if (ticks !== undefined && ticks <= RUNWAY_WARN_TICKS) {
          rows.push({ id: `runway-${id}`, severity: 'danger', subject: null, highlight: [],
            message: `${RESOURCES[id as ResourceId].name} empties in ~${ticks}t` });
        }
      }

      if (snapshot.homeless > 0) {
        // Plural rows pulse the people they name (§2.3). `homeId === null` is
        // the same predicate `commuteLabel` calls homeless, not a second one.
        rows.push({ id: 'homeless', severity: 'warn', subject: null,
          highlight: snapshot.colonists.filter((c) => c.homeId === null).map((c) => ({ kind: 'colonist' as const, id: c.id })),
          message: `${snapshot.homeless} colonist${snapshot.homeless === 1 ? ' has' : 's have'} no bed` });
      }
      const starving = snapshot.colonists.filter((c) => c.starvingTicks > 0);
      if (starving.length > 0) {
        rows.push({ id: 'starving', severity: 'danger', subject: null,
          highlight: starving.map((c) => ({ kind: 'colonist' as const, id: c.id })),
          message: `${starving.length} colonist${starving.length === 1 ? ' is' : 's are'} starving` });
      }
      if (snapshot.idleAdults > 0) {
        // The same three conditions `idleAdults` is counted from: an adult
        // with no building and no haul duty. Derived here rather than
        // published, because this increment adds no snapshot field.
        rows.push({ id: 'idle', severity: 'warn', subject: null,
          highlight: snapshot.colonists
            .filter((c) => c.stage === 'adult' && c.buildingId === null && !c.hauling)
            .map((c) => ({ kind: 'colonist' as const, id: c.id })),
          message: `${snapshot.idleAdults} adult${snapshot.idleAdults === 1 ? ' is' : 's are'} idle` });
      }

      return rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1));
    },
```

Widen the existing content import at the top of the file to include `BuildingDefId` if it is not already there (it is — the file already imports `type BuildingDefId`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/app/attention.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Check the line count**

Run: `npm run check:loc`
Expected: PASS. If `game-store.ts` is now over 500, move the attention block to `src/app/stores/attention.ts` as a plain function `attentionRows(snapshot, runways): AttentionRow[]` and have the getter delegate to it — the tests above are unchanged either way.

- [ ] **Step 6: Commit**

```bash
git add src/app/stores/game-store.ts tests/app/attention.test.ts
git commit -m "The problem list, derived from what the snapshot already says"
```

---

## Task 3: Widen the renderer seam

`renderer.ts` cannot be unit tested (Excalibur at module scope). The **seam** is what later tasks assert against with fakes; the implementation is covered by `vue-tsc` and `npm run smoke:world`.

**Files:**
- Modify: `src/app/world/renderer-key.ts`
- Modify: `src/app/world/renderer.ts`
- Modify: `scripts/world-smoke-harness/` (whichever file asserts renderer behaviour — read it first)

**Interfaces:**
- Consumes: `Selection` from Task 1.
- Produces the widened `WorldRenderer`:
  - `setSelection(selection: Selection): void`
  - `setHighlight(subjects: readonly Selection[]): void`

- [ ] **Step 1: Widen the seam**

In `src/app/world/renderer-key.ts`, replace the `setSelection` member and add three:

```ts
import type { Selection } from '../stores/ui-store';

  /** Highlight the selected subject (or clear, with `{ kind: 'none' }`). The
   * ring follows moves and disappears with its subject; the caller still owns
   * selection state. Colonists gained a ring in increment 11 — they were
   * hover-only before, though `pick` has always returned them. */
  setSelection(selection: Selection): void;
  /** Pulse a set of buildings without selecting any of them — what a plural
   * panel row does (spec §2.3). Passing an empty array clears the pulse. */
  setHighlight(subjects: readonly Selection[]): void;
```

- [ ] **Step 2: Run the typecheck to see every call site break**

Run: `npm run typecheck`
Expected: FAIL — `WorldView.vue` and `renderer.ts` do not satisfy the widened interface. This is the list of places Task 5 must touch.

- [ ] **Step 3: Implement the two new methods**

**`fitCamera` and `sync` are not touched.** Spec §2.1 cuts all camera work; a
grown map keeps behaving exactly as it does today, and OBS-11-01
(`docs/issues/2026-08-16-a-grown-map-shrinks-below-readability.md`) records why
and what a fix would need. If this task finds itself editing `fitCamera`,
`camera.pos` or `camera.zoom`, stop — that is the deferred increment, not this
one.

In `src/app/world/renderer.ts`, change `setSelection` to branch on the
discriminated `Selection` and add `setHighlight`:

```ts
    setSelection(selection) {
      if (!disposed) scene.setSelection(selection);
    },
    setHighlight(subjects) {
      if (!disposed) scene.setHighlight(subjects);
    },
```

In the scene, `setSelection` branches on `selection.kind`: a `building` draws
today's ring on the building actor, a `colonist` draws the same ring on the
colonist actor (they are already picked by `colonistAt`, so only the drawing is
new), and `none` clears it. `setHighlight` keeps one short-lived pulse actor per
subject — building or colonist, branching the same way `setSelection` does —
and replaces the whole set on each call, so an empty array clears it.

- [ ] **Step 4: Typecheck the renderer in isolation**

Run: `npm run typecheck`
Expected: the only remaining errors are in `WorldView.vue`, which Task 6 deletes. If `renderer.ts` itself errors, fix it here.

- [ ] **Step 5: Check the line count**

Run: `npm run check:loc`
Expected: PASS. If `renderer.ts` exceeds 500, extract the selection and highlight actors into `src/app/world/markers.ts` and have the scene hold one.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/renderer-key.ts src/app/world/renderer.ts
git commit -m "The seam learns about colonists and highlights"
```

---

## Task 4: `world/interaction.ts` — the mode machine without a DOM

**Files:**
- Create: `src/app/world/interaction.ts`
- Test: `tests/app/interaction.test.ts`

**Interfaces:**
- Consumes: `useUiStore` (Task 1); `isTileBuildable` from `src/shared/placement`.
- Produces: `useWorldInteraction()` returning `{ ghost: ComputedRef<GhostPreview | null>, hoverTile: Ref<Tile | null>, setHoverTile(tile), clickTile(tile): Command | null, clickPick(pick): void }`

- [ ] **Step 1: Write the failing tests**

Create `tests/app/interaction.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { useWorldInteraction } from '../../src/app/world/interaction';
import { makeBuilding, makeSnapshot } from './fixtures';

function setup(buildings = [makeBuilding(1, { col: 5, row: 5 })]) {
  setActivePinia(createPinia());
  useGameStore().ingest(makeSnapshot({ buildings }), { paused: true, speed: 1, error: null });
  return { ui: useUiStore(), interaction: useWorldInteraction() };
}

describe('useWorldInteraction', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('previews nothing while idle', () => {
    const { interaction } = setup();
    interaction.setHoverTile({ col: 2, row: 2 });
    expect(interaction.ghost.value).toBe(null);
  });

  it('previews a valid ghost on an empty tile while placing', () => {
    const { ui, interaction } = setup();
    ui.armPlace('farm');
    interaction.setHoverTile({ col: 2, row: 2 });
    expect(interaction.ghost.value).toEqual({ defId: 'farm', col: 2, row: 2, valid: true });
  });

  it('previews an invalid ghost on an occupied tile', () => {
    const { ui, interaction } = setup();
    ui.armPlace('farm');
    interaction.setHoverTile({ col: 5, row: 5 });
    expect(interaction.ghost.value!.valid).toBe(false);
  });

  it('dispatches a construct command on a valid placing click, and stays armed', () => {
    const { ui, interaction } = setup();
    ui.armPlace('farm');
    expect(interaction.clickTile({ col: 2, row: 2 }))
      .toEqual({ type: 'constructBuilding', buildingDefId: 'farm', at: { col: 2, row: 2 } });
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' }); // repeat placement
  });

  it('refuses a placing click on an occupied tile', () => {
    const { ui, interaction } = setup();
    ui.armPlace('farm');
    expect(interaction.clickTile({ col: 5, row: 5 })).toBe(null);
  });

  it('dispatches a move command and returns to idle', () => {
    const { ui, interaction } = setup();
    ui.selectBuilding(1);
    ui.armMove(1);
    expect(interaction.clickTile({ col: 8, row: 8 }))
      .toEqual({ type: 'moveBuilding', buildingId: 1, to: { col: 8, row: 8 } });
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'building', id: 1 }); // selection survives
  });

  it('selects a building from an idle canvas click and clears on empty ground', () => {
    const { ui, interaction } = setup();
    interaction.clickPick({ kind: 'building', id: 1 });
    expect(ui.selection).toEqual({ kind: 'building', id: 1 });
    interaction.clickPick(null);
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  it('selects a colonist from an idle canvas click', () => {
    const { ui, interaction } = setup();
    interaction.clickPick({ kind: 'colonist', id: 3 });
    expect(ui.selection).toEqual({ kind: 'colonist', id: 3 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/interaction.test.ts`
Expected: FAIL — cannot resolve `interaction`.

- [ ] **Step 3: Write the composable**

Create `src/app/world/interaction.ts`:

```ts
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { isTileBuildable } from '../../shared/placement';
import type { Command } from '../../shared/commands';
import { useGameStore } from '../stores/game-store';
import { useUiStore } from '../stores/ui-store';
import type { GhostPreview } from './renderer-key';
import type { WorldPick } from './layout';

export interface Tile { col: number; row: number; }

/**
 * The idle / place / move machine, lifted out of WorldView so it can be
 * exercised with no canvas, no WebGL and no DOM (spec §2.6). The mode itself
 * lives in the UI store, because §2.1's cancel invariant has to sit beside
 * the selection it is coupled to; this composable is the behaviour over it.
 *
 * Validity here is COSMETIC only. The engine revalidates and rejects with a
 * notice, so a stale ghost is wrong for at most one tick. Tile occupancy is
 * the only thing checked, for both modes alike: since increment 10 an order
 * is a request, so an unaffordable def previews exactly as valid as an
 * affordable one and the queue fills as goods arrive.
 */
export function useWorldInteraction(): {
  ghost: ComputedRef<GhostPreview | null>;
  hoverTile: Ref<Tile | null>;
  setHoverTile(tile: Tile | null): void;
  clickTile(tile: Tile | null): Command | null;
  clickPick(pick: WorldPick | null): void;
} {
  const store = useGameStore();
  const ui = useUiStore();
  const hoverTile = ref<Tile | null>(null);

  function tileValid(col: number, row: number): boolean {
    const snapshot = store.snapshot;
    if (!snapshot) return false;
    return isTileBuildable(snapshot.map, snapshot.buildings, col, row);
  }

  /** The def a ghost previews: the armed def, or the moved building's own. */
  const ghostDefId = computed(() => {
    const mode = ui.mode;
    if (mode.kind === 'place') return mode.defId;
    if (mode.kind === 'move') {
      return store.snapshot?.buildings.find((b) => b.id === mode.buildingId)?.defId ?? null;
    }
    return null;
  });

  const ghost = computed<GhostPreview | null>(() => {
    const defId = ghostDefId.value;
    const tile = hoverTile.value;
    if (defId === null || tile === null) return null;
    return { defId, col: tile.col, row: tile.row, valid: tileValid(tile.col, tile.row) };
  });

  function setHoverTile(tile: Tile | null) { hoverTile.value = tile; }

  function clickTile(tile: Tile | null): Command | null {
    const mode = ui.mode;
    if (mode.kind === 'idle' || tile === null) return null;
    if (!tileValid(tile.col, tile.row)) return null;
    if (mode.kind === 'place') {
      // stays armed — Banished-style repeat placement
      return { type: 'constructBuilding', buildingDefId: mode.defId, at: tile };
    }
    ui.cancelMode(); // back to idle; the selection stays on the moved building
    return { type: 'moveBuilding', buildingId: mode.buildingId, to: tile };
  }

  function clickPick(pick: WorldPick | null) {
    if (pick === null) { ui.clearSelection(); return; }
    if (pick.kind === 'colonist') { ui.selectColonist(pick.id); return; }
    ui.selectBuilding(pick.id);
  }

  return { ghost, hoverTile, setHoverTile, clickTile, clickPick };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/app/interaction.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/world/interaction.ts tests/app/interaction.test.ts
git commit -m "The mode machine, testable without a canvas"
```

---

## Task 5: `WorldStage.vue` — the canvas host

Read `src/app/views/WorldView.vue` in full before starting: this task moves its renderer lifecycle, hover and tooltip across, and drops its mode and selection state (now Tasks 1 and 4).

**Files:**
- Create: `src/app/views/WorldStage.vue`
- Test: `tests/app/world-stage.test.ts`
- Reference: `src/app/views/WorldView.vue` (deleted in Task 6), `tests/app/world-view.test.ts` (its cases are split between this task and Task 6)

**Interfaces:**
- Consumes: `useWorldInteraction` (Task 4), `useUiStore` (Task 1), the widened `WorldRenderer` (Task 3), and **`ENGINE_KEY`** — `clickTile` returns a `Command`, and this is the component that sends it.
- Produces: a component that emits `fatal: [message: string]` and renders a host div with class `obsisim-world-host`.

- [ ] **Step 1: Write the failing tests**

Create `tests/app/world-stage.test.ts`. Reuse `makeFake` and the injection pattern from `tests/app/world-view.test.ts`, widened for the new seam:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldStage from '../../src/app/views/WorldStage.vue';
import { WORLD_RENDERER_KEY, type WorldRenderer } from '../../src/app/world/renderer-key';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot } from './fixtures';

function makeFake() {
  const renderer: WorldRenderer = {
    sync: vi.fn(), pick: vi.fn(() => null), tileAt: vi.fn(() => null),
    setGhost: vi.fn(), setSelection: vi.fn(), setHighlight: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
  return { renderer, factory: vi.fn(() => renderer) };
}

function mountStage(factory: unknown) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(WorldStage, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: engine },
    },
  });
  return { wrapper, engine };
}

describe('WorldStage', () => {
  it('creates the renderer on its host and syncs snapshots', async () => {
    const { renderer, factory } = makeFake();
    mountStage(factory);
    expect(factory).toHaveBeenCalledOnce();
    const snapshot = makeSnapshot({ tick: 5 });
    useGameStore().ingest(snapshot, { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.sync).toHaveBeenCalledWith(snapshot);
  });

  it('forwards the store selection to the renderer', async () => {
    const { renderer, factory } = makeFake();
    mountStage(factory);
    useUiStore().selectColonist(4);
    await nextTick();
    expect(renderer.setSelection).toHaveBeenCalledWith({ kind: 'colonist', id: 4 });
  });

  it('forwards a highlight set to the renderer', async () => {
    const { renderer, factory } = makeFake();
    mountStage(factory);
    useUiStore().setHighlight([2, 3]);
    await nextTick();
    expect(renderer.setHighlight).toHaveBeenCalledWith([2, 3]);
  });

  it('emits fatal when the factory throws, and renders no host', () => {
    const factory = vi.fn(() => { throw new Error('no webgl'); });
    const { wrapper } = mountStage(factory);
    expect(wrapper.emitted('fatal')![0]).toEqual(['no webgl']);
  });

  it('emits fatal when the renderer reports one after a successful boot', () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    const report = (renderer.onFatal as ReturnType<typeof vi.fn>).mock.calls[0][0] as (m: string) => void;
    report('context lost');
    expect(wrapper.emitted('fatal')![0]).toEqual(['context lost']);
  });

  it('dispatches the construct command a placing click produces', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper, engine } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 2, row: 2 });
    useUiStore().armPlace('farm');
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'farm', at: { col: 2, row: 2 } });
  });

  it('dispatches the move command a moving click produces', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper, engine } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(1, { col: 5, row: 5 })] }), { paused: true, speed: 1, error: null });
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 8, row: 8 });
    const ui = useUiStore();
    ui.selectBuilding(1);
    ui.armMove(1);
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 8, row: 8 } });
  });

  it('forwards the computed ghost to the renderer', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 2, row: 2 });
    useUiStore().armPlace('farm');
    await nextTick();
    // A pointer move is what supplies the tile; the ghost follows from it.
    await wrapper.get('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenCalledWith({ defId: 'farm', col: 2, row: 2, valid: true });
  });

  it('drops a colonist selection when that colonist dies, not when a building vanishes', async () => {
    const { factory } = makeFake();
    mountStage(factory);
    const store = useGameStore();
    const ui = useUiStore();
    store.ingest(makeSnapshot({ tick: 1, colonists: [makeWorker(3)], buildings: [] }), { paused: true, speed: 1, error: null });
    ui.selectColonist(3);
    await nextTick();
    // Still alive, and no building shares the id — a buildings-only check would
    // have cleared this.
    store.ingest(makeSnapshot({ tick: 2, colonists: [makeWorker(3)], buildings: [] }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.selection).toEqual({ kind: 'colonist', id: 3 });

    store.ingest(makeSnapshot({ tick: 3, colonists: [], buildings: [makeBuilding(3)] }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.selection).toEqual({ kind: 'none' }); // dead, despite a building with id 3
  });

  it('stops the render clock on deactivate and restarts it on activate', async () => {
    const { renderer, factory } = makeFake();
    const active = ref(true);
    const Harness = defineComponent({
      setup: () => () => h(KeepAlive, null, [active.value ? h(WorldStage) : null]),
    });
    mount(Harness, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    active.value = false;
    await nextTick();
    expect(renderer.stop).toHaveBeenCalled();
    active.value = true;
    await nextTick();
    expect(renderer.start).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce(); // never rebuilt
  });

  it('selects the picked building on an idle canvas click', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 1 });
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(1)] }), { paused: true, speed: 1, error: null });
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 101, pageY: 100 });
    expect(useUiStore().selection).toEqual({ kind: 'building', id: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/world-stage.test.ts`
Expected: FAIL — cannot resolve `WorldStage.vue`.

- [ ] **Step 3: Write the component**

Create `src/app/views/WorldStage.vue`. Carry over from `WorldView.vue` verbatim: the `onMounted` factory call and try/catch, the `watch` on `store.snapshot` with `{ immediate: true }`, the reset detection (`snapshot.tick <= previousSnapshot.tick`), `revalidateHover`, `armHoverRecheck` and the 2000ms tail, `onBeforeUnmount` disposal, **and the `onActivated`/`onDeactivated` pair that starts and stops the render clock**.

The id-based selection lifecycle is the one thing that must **not** come across
verbatim. `WorldView` checks a numeric `selectedId` against `snapshot.buildings`
alone, which was right when only a building could be selected. Building and
colonist ids are independent counters, so applied to a `Selection` that check
would clear a living colonist whose id happens to match no building, and keep a
dead one whose id happens to match a building. Branch on the kind:

```ts
// A selection dies with its subject — and which list decides that depends on
// what the subject IS. The move mode's own lifecycle stays building-only,
// because only a building can be moved.
function pruneSelection(snapshot: Snapshot | null) {
  const selection = ui.selection;
  if (selection.kind === 'building' && !snapshot?.buildings.some((b) => b.id === selection.id)) ui.clearSelection();
  if (selection.kind === 'colonist' && !snapshot?.colonists.some((c) => c.id === selection.id)) ui.clearSelection();
  const mode = ui.mode;
  if (mode.kind === 'move' && !snapshot?.buildings.some((b) => b.id === mode.buildingId)) ui.cancelMode();
}
```

```ts
// Not optional, and not obsolete after the dock: WorldScreen is still under
// <keep-alive>, so a trip to /ledger deactivates this component without
// unmounting it. Without these the Excalibur clock keeps running behind the
// Ledger and only final unmount ever stops it (spec §2.1 retains the pair).
onActivated(() => renderer?.start());
onDeactivated(() => renderer?.stop());
``` Replace its mode/selection state with `useUiStore()` and `useWorldInteraction()`.

New in this component — the **three** watchers that forward state through the
seam, replacing what `WorldView` used to own directly:

```ts
watch(() => ui.selection, (selection) => renderer?.setSelection(selection), { deep: true });
watch(() => ui.highlight, (subjects) => renderer?.setHighlight(subjects), { deep: true });
// The ghost is the third and it is easy to forget: WorldView called setGhost
// from its own refreshGhost(), and that function leaves with WorldView. Task 4
// moved the COMPUTATION into useWorldInteraction().ghost, which nothing draws
// until this line — without it an armed place or move dispatches correctly on
// click and previews nothing at all, and a validity change under a stationary
// pointer never reaches the canvas.
watch(interaction.ghost, (ghost) => renderer?.setGhost(ghost), { deep: true });
```

`onPointerMove`, `onPointerLeave` and `onContextMenu` come across from
`WorldView` unchanged in shape, with their mode and selection reads redirected
to `useWorldInteraction()` and `useUiStore()`. There is no drag-to-pan: §2.1
cuts camera work, so a pointer drag is not a gesture this canvas has.

`onClick` is the one that changes, and it is the whole point of the screen:

```ts
const engine = inject(ENGINE_KEY)!;

// clickTile RETURNS a Command — it deliberately dispatches nothing itself, so
// that Task 4's composable stays testable with no engine at all. That makes
// this line the only thing standing between an armed placement and a building:
// drop it and every construct and move click updates the UI, arms, disarms and
// previews correctly while the colony never changes.
function onClick(event: MouseEvent) {
  if (ui.mode.kind !== 'idle') {
    const command = interaction.clickTile(renderer?.tileAt(event.pageX, event.pageY) ?? null);
    if (command !== null) engine.dispatch(command);
    return;
  }
  interaction.clickPick(renderer?.pick(event.pageX, event.pageY) ?? null);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/app/world-stage.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/views/WorldStage.vue tests/app/world-stage.test.ts
git commit -m "The canvas host, without the selection state it used to own"
```

---

## Task 6: `WorldScreen.vue` — the shell, and deleting `WorldView`

**Files:**
- Create: `src/app/views/WorldScreen.vue`
- Delete: `src/app/views/WorldView.vue`, `tests/app/world-view.test.ts`
- Test: `tests/app/world-screen.test.ts`

**Interfaces:**
- Consumes: `WorldStage` (Task 5), `useUiStore` (Task 1), `BuildPalette`, `WorldLegend`.
- Produces: the component the `/` route renders. Dock slots are filled in Tasks 7–11; until then the dock renders a placeholder per panel.

- [ ] **Step 1: Write the failing tests**

Create `tests/app/world-screen.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldScreen from '../../src/app/views/WorldScreen.vue';
import { WORLD_RENDERER_KEY, type WorldRenderer } from '../../src/app/world/renderer-key';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useUiStore } from '../../src/app/stores/ui-store';

function makeFake(): WorldRenderer {
  return {
    sync: vi.fn(), pick: vi.fn(() => null), tileAt: vi.fn(() => null),
    setGhost: vi.fn(), setSelection: vi.fn(), setHighlight: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
}

function mountScreen() {
  return mount(WorldScreen, {
    attachTo: document.body, // window keydown listeners need a live document
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: {
        [WORLD_RENDERER_KEY as symbol]: vi.fn(() => makeFake()),
        [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
      },
    },
  });
}

describe('WorldScreen', () => {
  it('renders the rail, the stage and the strip, with no dock by default', () => {
    const wrapper = mountScreen();
    expect(wrapper.find('[data-test="build-palette"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="world-host"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="resource-strip"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="dock"]').exists()).toBe(false);
  });

  it('opens the dock when a panel is chosen', async () => {
    const wrapper = mountScreen();
    useUiStore().openPanel('attention');
    await nextTick();
    expect(wrapper.find('[data-test="dock"]').exists()).toBe(true);
  });

  it('unwinds the Escape ladder mode-first', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    ui.selectBuilding(1);
    ui.armMove(1);
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'building', id: 1 });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'none' });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.panel).toBe(null);
    wrapper.unmount();
  });

  it('collapses the rail to a Build control in a narrow pane, and the popover still arms', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    expect(wrapper.find('[data-test="rail-toggle"]').exists()).toBe(false);
    ui.setNarrow(true);
    await nextTick();
    expect(wrapper.find('[data-test="build-palette"]').exists()).toBe(false);
    await wrapper.get('[data-test="rail-toggle"]').trigger('click');
    await wrapper.get('[data-test="palette-farm"]').trigger('click');
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' });
    wrapper.unmount();
  });

  it('overlays the dock rather than shrinking the canvas in a narrow pane', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    ui.openPanel('attention');
    await nextTick();
    expect(wrapper.get('[data-test="dock"]').classes()).not.toContain('is-overlay');
    ui.setNarrow(true);
    await nextTick();
    // The other half of criterion 7. Without this, an implementation that
    // leaves the dock in a grid column and crushes the canvas passes every
    // other check, because Task 13's CSS is where that decision lives.
    expect(wrapper.get('[data-test="dock"]').classes()).toContain('is-overlay');
    wrapper.unmount();
  });

  it('stops listening for Escape while deactivated, and resumes on activate', async () => {
    const active = ref(true);
    const Harness = defineComponent({
      setup: () => () => h(KeepAlive, null, [active.value ? h(WorldScreen) : null]),
    });
    mount(Harness, {
      attachTo: document.body,
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: {
          [WORLD_RENDERER_KEY as symbol]: vi.fn(() => makeFake()),
          [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
        },
      },
    });
    const ui = useUiStore();
    ui.selectBuilding(1);
    active.value = false;
    await nextTick();

    // The Ledger is showing. Escape belongs to it, not to the hidden world.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'building', id: 1 });

    active.value = true;
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  it('detaches its Escape listener on unmount', () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    ui.selectBuilding(1);
    wrapper.unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'building', id: 1 }); // untouched
  });

  it('shows the fallback message when the stage reports a fatal', async () => {
    const wrapper = mount(WorldScreen, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: {
          [WORLD_RENDERER_KEY as symbol]: vi.fn(() => { throw new Error('no webgl'); }),
          [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
        },
      },
    });
    await nextTick();
    expect(wrapper.find('[data-test="world-fallback"]').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/world-screen.test.ts`
Expected: FAIL — cannot resolve `WorldScreen.vue`.

- [ ] **Step 3: Write the shell**

Create `src/app/views/WorldScreen.vue`:

```vue
<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import type { BuildingDefId } from '../../shared/content-types';
import { useUiStore } from '../stores/ui-store';
import WorldStage from './WorldStage.vue';
import BuildPalette from '../components/BuildPalette.vue';
import ResourceStrip from '../components/ResourceStrip.vue';
import WorldLegend from '../components/WorldLegend.vue';

defineOptions({ name: 'WorldScreen' }); // keep-alive include matches on this

const ui = useUiStore();
const failure = ref<string | null>(null);
const root = ref<HTMLElement | null>(null);

/*
 * Two consumers, deliberately. The local ref renders the inline fallback for
 * the frame before navigation lands (and for a WorldScreen mounted outside the
 * router, which the tests do). The store write is what `App.vue` watches to
 * reach the Ledger at all — see ui-store's comment on `rendererFailure`.
 */
function onFatal(message: string) {
  failure.value = message;
  ui.reportRendererFailure(message);
}

/** Below this the dock overlays the canvas instead of shrinking it, and the
 * rail collapses. Measured on the PANE, not the window: this view can be
 * dragged into an Obsidian sidebar beside a full-width note (spec §2.1). */
const NARROW_PX = 720;

/*
 * In a narrow pane the rail collapses to one Build control that opens the
 * palette as a popover (spec §2.1). This has to be state rather than CSS: CSS
 * can hide or shrink the palette, but it cannot make an operable popover, and a
 * rail that collapsed with no replacement control would put constructBuilding
 * out of reach in exactly the layout the collapse is for.
 */
const railOpen = ref(false);
const paletteVisible = computed(() => !ui.narrow || railOpen.value);

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (ui.escape()) event.preventDefault();
}

/*
 * The listener is bound to VISIBILITY, not to mount, and that distinction is
 * load-bearing: this component stays under <keep-alive>, so a trip to /ledger
 * deactivates it without unmounting it. A mount-scoped listener would keep
 * running behind the Ledger — clearing the hidden world's mode, selection or
 * dock, and swallowing an Escape the Ledger or Obsidian itself wanted.
 *
 * This is `WorldView`'s `viewActive` guard in its new home. It was written for
 * the tab switches this increment deletes; the one route trip that survives is
 * exactly the case it still covers.
 */
let listening = false;
function listen(on: boolean) {
  if (on === listening) return;
  if (on) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
  listening = on;
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  listen(true);
  if (root.value !== null && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(([entry]) => ui.setNarrow(entry.contentRect.width < NARROW_PX));
    observer.observe(root.value);
  }
});
onActivated(() => listen(true));
onDeactivated(() => listen(false));
onBeforeUnmount(() => {
  listen(false);
  observer?.disconnect();
});
</script>

<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). Open the Ledger to keep playing.
  </div>
  <div v-else ref="root" class="obsisim-world-screen" :class="{ 'is-narrow': ui.narrow }">
    <button v-if="ui.narrow" data-test="rail-toggle" :class="{ 'is-armed': railOpen }"
      @click="railOpen = !railOpen">Build</button>
    <BuildPalette v-if="paletteVisible" class="obsisim-rail"
      :armed-def-id="ui.mode.kind === 'place' ? ui.mode.defId : null"
      @arm="(id: BuildingDefId) => { ui.armPlace(id); railOpen = false; }" @disarm="ui.cancelMode" />
    <WorldStage class="obsisim-stage" @fatal="onFatal" />
    <!-- `is-overlay` is state, not a media query, so criterion 7's other half
         is assertable in jsdom: the CSS keys off this class rather than off a
         container query alone, and a test can prove the dock stops taking a
         grid column instead of only proving the rail collapsed. -->
    <aside v-if="ui.panel" class="obsisim-dock" :class="{ 'is-overlay': ui.narrow }" data-test="dock">
      <!-- Tasks 7-11 replace this with the five panels. -->
    </aside>
    <ResourceStrip class="obsisim-strip" />
    <WorldLegend />
  </div>
</template>
```

- [ ] **Step 4: Delete `WorldView` and its test**

```bash
git rm src/app/views/WorldView.vue tests/app/world-view.test.ts
```

Its behaviour is now split across `ui-store` (Task 1), `interaction.ts` (Task 4), `WorldStage` (Task 5) and this shell, and every case it asserted has an equivalent in one of those four test files.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. Failures will be in `src/app/router.ts` and `App.vue`, which still import `WorldView` — Task 12 rewires them, so if the suite cannot even load, do the router edit now and leave the Ledger for Task 12.

- [ ] **Step 6: Commit**

```bash
git add -A src/app/views tests/app
git commit -m "The world screen replaces the world tab"
```

---

## Task 7: The Inspector panel — staffing on the canvas

**Files:**
- Create: `src/app/components/dock/InspectorPanel.vue`
- Delete: `src/app/components/SelectionPanel.vue`, `tests/app/selection-panel.test.ts`
- Test: `tests/app/dock-panels.test.ts` (created here, extended by Tasks 8–11)

**Interfaces:**
- Consumes: `useUiStore().selection`, `useGameStore()`, `ENGINE_KEY`.
- Produces: nothing later tasks depend on beyond the file existing and being mounted by `WorldScreen`.

- [ ] **Step 1: Write the failing tests**

Create `tests/app/dock-panels.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import InspectorPanel from '../../src/app/components/dock/InspectorPanel.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot, makeWorker } from './fixtures';

function mountPanel(component: unknown, snapshot = makeSnapshot()) {
  const engine = { dispatch: vi.fn() };
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  useGameStore(pinia).ingest(snapshot, { paused: true, speed: 1, error: null });
  const wrapper = mount(component as never, {
    global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } },
  });
  return { wrapper, engine, ui: useUiStore(pinia) };
}

describe('InspectorPanel', () => {
  const staffable = makeSnapshot({
    idleAdults: 2,
    buildings: [makeBuilding(1, { defId: 'farm', workers: 1, workerSlots: 3, state: 'producing' })],
  });

  it('assigns a worker to the selected building', async () => {
    const { wrapper, engine, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="inspector-assign"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignWorker', buildingId: 1 });
  });

  it('unassigns a worker from the selected building', async () => {
    const { wrapper, engine, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="inspector-unassign"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignWorker', buildingId: 1 });
  });

  it('disables assign with no idle adults and says why', async () => {
    const none = makeSnapshot({ idleAdults: 0, buildings: [makeBuilding(1, { workers: 1, workerSlots: 3 })] });
    const { wrapper, ui } = mountPanel(InspectorPanel, none);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector-assign"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="inspector-staffing-reason"]').text()).toContain('No idle adults');
  });

  it('refuses staffing on a construction site and states the reason', async () => {
    const site = makeSnapshot({
      idleAdults: 3,
      buildings: [makeBuilding(1, { workers: 0, workerSlots: 3, state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, site);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector-assign"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="inspector-staffing-reason"]').text()).toContain('cannot be staffed');
  });

  it('refuses Move on a construction site and states the reason in the panel', async () => {
    const site = makeSnapshot({
      buildings: [makeBuilding(1, { state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, site);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector-move"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="inspector-move-reason"]').text()).toContain('under construction');
  });

  it('arms move mode rather than dispatching immediately', async () => {
    const { wrapper, engine, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="inspector-move"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
    expect(ui.mode).toEqual({ kind: 'move', buildingId: 1 });
  });

  it('lists a house occupant and selects the colonist on click', async () => {
    const house = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'house', beds: 4, occupants: 1, workerSlots: 0, state: 'housing' })],
      colonists: [makeWorker(9, { homeId: 1 })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, house);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="occupant-9"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'colonist', id: 9 });
  });

  it('describes a selected colonist instead of a building', async () => {
    const peopled = makeSnapshot({ colonists: [makeWorker(9, { ageTicks: 2500 })] });
    const { wrapper, ui } = mountPanel(InspectorPanel, peopled);
    ui.selectColonist(9);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector-colonist"]').text()).toContain('#9');
  });

  it('renders nothing when nothing is selected', () => {
    const { wrapper } = mountPanel(InspectorPanel, staffable);
    expect(wrapper.find('[data-test="inspector"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: FAIL — cannot resolve `InspectorPanel.vue`.

- [ ] **Step 3: Write the panel**

Create `src/app/components/dock/InspectorPanel.vue`. Carry `SelectionPanel.vue`'s per-kind detail across (buffers, storage, relocation countdown, construction countdown and `needsLabel`), branch first on `ui.selection.kind`, and add:

```vue
    <!-- Stated in the panel rather than in a `title`: spec §2.2 makes explicit
         what SelectionPanel already argued for Move — a control the engine
         would refuse must say so where the player is looking. -->
    <div class="obsisim-inspector-staffing">
      <button data-test="inspector-unassign" :disabled="building.workers === 0"
        @click="engine.dispatch({ type: 'unassignWorker', buildingId: building.id })">−</button>
      <span>{{ building.workers }} / {{ building.workerSlots }}</span>
      <button data-test="inspector-assign"
        :disabled="staffingReason !== null"
        @click="engine.dispatch({ type: 'assignWorker', buildingId: building.id })">+</button>
    </div>
    <p v-if="staffingReason" class="obsisim-reason" data-test="inspector-staffing-reason">{{ staffingReason }}</p>
```

with

```ts
const staffingReason = computed(() => {
  const b = building.value;
  if (b === null) return null;
  // A site refuses staffing outright (`handleAssignWorker`), and it keeps its
  // def's workerSlots, so without this the Inspector offers a control the
  // engine is certain to reject — the same failure the Move button already
  // guards against, on the same building kind.
  if (b.constructionTicks > 0) return 'A construction site cannot be staffed until it is finished.';
  if (b.workers >= b.workerSlots) return 'Every slot is filled.';
  if (store.snapshot!.idleAdults === 0) return 'No idle adults — unassign someone first.';
  return null;
});

const moveReason = computed(() =>
  building.value !== null && building.value.constructionTicks > 0
    ? 'A building under construction cannot be moved.'
    : null);
```

Move emits into the store rather than dispatching: `@click="ui.armMove(building.id)"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire it into the dock and delete `SelectionPanel`**

In `WorldScreen.vue`'s `<aside>`, render `<InspectorPanel v-if="ui.panel === 'inspector'" />`. Then:

```bash
git rm src/app/components/SelectionPanel.vue tests/app/selection-panel.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A src/app/components src/app/views tests/app
git commit -m "Staffing moves onto the canvas, and a refusal says so in the panel"
```

---

## Task 8: The resource strip and the Colony panel — haulers on the canvas

**Files:**
- Create: `src/app/components/ResourceStrip.vue`, `src/app/components/dock/ColonyPanel.vue`
- Test: `tests/app/resource-strip.test.ts`, extend `tests/app/dock-panels.test.ts`

**Interfaces:**
- Consumes: `useGameStore().runways`, `.haulerCount`; `ENGINE_KEY`.
- Produces: `data-test="resource-strip"`, which `WorldScreen`'s test (Task 6) already asserts.

- [ ] **Step 1: Write the failing tests**

Create `tests/app/resource-strip.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import ResourceStrip from '../../src/app/components/ResourceStrip.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot, makeWorker, stockedWith } from './fixtures';

function mountStrip(snapshot = makeSnapshot()) {
  const engine = { dispatch: vi.fn() };
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  useGameStore(pinia).ingest(snapshot, { paused: true, speed: 1, error: null });
  return { wrapper: mount(ResourceStrip, { global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } } }), engine };
}

describe('ResourceStrip', () => {
  it('assigns a hauler', async () => {
    const { wrapper, engine } = mountStrip(makeSnapshot({ idleAdults: 1 }));
    await wrapper.get('[data-test="assign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignHauler' });
  });

  it('unassigns a hauler', async () => {
    const { wrapper, engine } = mountStrip(makeSnapshot({ colonists: [makeWorker(1, { hauling: true })] }));
    await wrapper.get('[data-test="unassign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignHauler' });
  });

  it('disables assign with no idle adults AND says why', () => {
    const { wrapper } = mountStrip(makeSnapshot({ idleAdults: 0 }));
    expect(wrapper.get('[data-test="assign-hauler"]').attributes('disabled')).toBeDefined();
    // §2.2: visible, not hidden in a title. A disabled control with no stated
    // reason is the exact thing that rule exists to stop.
    expect(wrapper.get('[data-test="hauler-reason"]').text()).toContain('No idle adults');
  });

  it('marks a short runway', () => {
    const { wrapper } = mountStrip(makeSnapshot({
      stockpile: { ...stockedWith({ bread: 20 }), bread: { stock: 20, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    }));
    expect(wrapper.get('[data-test="strip-bread"]').classes()).toContain('obsisim-negative');
  });
});
```

Add to `tests/app/dock-panels.test.ts`:

```ts
import ColonyPanel from '../../src/app/components/dock/ColonyPanel.vue';

describe('ColonyPanel', () => {
  it('lists every resource with its runway', () => {
    const { wrapper } = mountPanel(ColonyPanel, makeSnapshot({ stockpile: stockedWith({ wood: 42 }) }));
    expect(wrapper.get('[data-test="colony-row-wood"]').text()).toContain('42');
  });

  it('does not select anything when a resource row is clicked', async () => {
    const { wrapper, ui } = mountPanel(ColonyPanel, makeSnapshot({ stockpile: stockedWith({ wood: 42 }) }));
    await wrapper.get('[data-test="colony-row-wood"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'none' });
    expect(ui.highlight).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/resource-strip.test.ts tests/app/dock-panels.test.ts`
Expected: FAIL on the two new files.

- [ ] **Step 3: Write both components**

`ResourceStrip.vue` renders one chip per `RESOURCE_IDS` entry — glyph, stock, and `~Nt` when `store.runways[id]` is defined — with class `obsisim-negative` at or under 30 ticks, plus the hauler `−`/`+` pair.

The hauler pair is **not** lifted verbatim: the Dashboard's version explains a
disabled `+` with a `title` alone, and §2.2 requires a refused control to state
its reason where the player is looking. Same rule the Inspector's staffing and
Move controls follow, and the engine's own refusal is *"No idle workers
available"*:

```vue
    <span class="obsisim-haulers">
      Haulers: <strong data-test="hauler-count">{{ store.haulerCount }}</strong>
      <button data-test="unassign-hauler" :disabled="store.haulerCount === 0"
        @click="engine.dispatch({ type: 'unassignHauler' })">−</button>
      <button data-test="assign-hauler" :disabled="store.snapshot!.idleAdults === 0"
        @click="engine.dispatch({ type: 'assignHauler' })">+</button>
      <small v-if="store.snapshot!.idleAdults === 0" class="obsisim-reason" data-test="hauler-reason">
        No idle adults — unassign someone first.
      </small>
    </span>
```

`ColonyPanel.vue` is `DashboardView.vue`'s existing `<table>` moved into a panel. Its rows carry `data-test="colony-row-<id>"` and **no click handler at all** — inertness is the absence of a handler, and the test above is what stops a later change adding one silently.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/app/resource-strip.test.ts tests/app/dock-panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components tests/app
git commit -m "Haulers move onto the world screen, and a resource row stays inert"
```

---

## Task 9: The Population panel — nomads on the canvas, colonists selectable

**Files:**
- Create: `src/app/components/dock/PopulationPanel.vue`
- Test: extend `tests/app/dock-panels.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import PopulationPanel from '../../src/app/components/dock/PopulationPanel.vue';
import { NOMAD_REJECTIONS } from '../../src/shared/population';

describe('PopulationPanel', () => {
  const peopled = makeSnapshot({
    population: 2, beds: { total: 4, occupied: 2 }, mealsPerHead: 30,
    demographics: { children: 0, adults: 2, elders: 0 },
    colonists: [makeWorker(1), makeWorker(2)],
    stockpile: stockedWith({ bread: 400 }),
  });

  it('welcomes a nomad', async () => {
    const { wrapper, engine } = mountPanel(PopulationPanel, peopled);
    await wrapper.get('[data-test="recruit"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'recruitWorker' });
  });

  it('names the gate that is shut instead of a bare disabled button', () => {
    const hungry = makeSnapshot({ population: 2, beds: { total: 4, occupied: 2 }, colonists: [makeWorker(1)] });
    const { wrapper } = mountPanel(PopulationPanel, hungry);
    expect(wrapper.get('[data-test="recruit"]').attributes('disabled')).toBeDefined();
    expect(Object.values(NOMAD_REJECTIONS)).toContain(wrapper.get('[data-test="recruit-reason"]').text());
  });

  it('selects a colonist when their row is clicked', async () => {
    const { wrapper, ui } = mountPanel(PopulationPanel, peopled);
    await wrapper.get('[data-test="colonist-row-2"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'colonist', id: 2 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: FAIL — cannot resolve `PopulationPanel.vue`.

- [ ] **Step 3: Write the panel**

`PopulationPanel.vue` is `PopulationView.vue`'s headline block and colonist table, with `PopulationSummary` reused unchanged and every `<tr>` carrying `:data-test="`colonist-row-${w.id}`"` and `@click="ui.selectColonist(w.id)"`. Every label function (`ageLabel`, `commuteLabel`, `jobLabel`, `starvingLabel`, the class helpers) comes from `labels.ts` or is copied across from `PopulationView.vue` — do not re-derive any of them.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/dock/PopulationPanel.vue tests/app/dock-panels.test.ts
git commit -m "Welcoming a nomad, and a colonist row that reaches the map"
```

---

## Task 10: The Economy panel — a stage highlights its whole def

**Files:**
- Create: `src/app/components/dock/EconomyPanel.vue`
- Test: extend `tests/app/dock-panels.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import EconomyPanel from '../../src/app/components/dock/EconomyPanel.vue';

describe('EconomyPanel', () => {
  it('highlights every building of a stage rather than selecting one, clearing any standing selection', async () => {
    const two = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'farm' }), makeBuilding(2, { defId: 'farm' })],
    });
    const { wrapper, ui } = mountPanel(EconomyPanel, two);
    ui.selectBuilding(2);
    await wrapper.get('[data-test="stage-row-farm"]').trigger('click');
    expect(ui.highlight).toEqual([{ kind: 'building', id: 1 }, { kind: 'building', id: 2 }]);
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  it('highlights a single-instance stage too, rather than selecting it', async () => {
    const one = makeSnapshot({ buildings: [makeBuilding(1, { defId: 'farm' })] });
    const { wrapper, ui } = mountPanel(EconomyPanel, one);
    await wrapper.get('[data-test="stage-row-farm"]').trigger('click');
    expect(ui.highlight).toEqual([{ kind: 'building', id: 1 }]);
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  it('highlights nothing for a stage with no buildings', async () => {
    const { wrapper, ui } = mountPanel(EconomyPanel, makeSnapshot({ buildings: [] }));
    await wrapper.get('[data-test="stage-row-farm"]').trigger('click');
    expect(ui.highlight).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: FAIL — cannot resolve `EconomyPanel.vue`.

- [ ] **Step 3: Write the panel**

`EconomyPanel.vue` is `EconomyView.vue`'s `chains` computed and its three pressure lines, unchanged, with each stage row gaining:

```ts
// A stage is a def, not a building: EconomyView emits one row per CHAINS step
// and aggregates through staffingByDef, so a stage stands for none, one or six
// buildings. Highlighting the whole set — even a set of one — keeps the click
// from behaving differently depending on a count the player is not looking at
// (spec §2.3).
function highlightStage(defId: BuildingDefId) {
  // Clears for the same reason AttentionPanel's plural rows do: a stage row's
  // result is "highlights every building of that def; selects nothing", and a
  // selection survives the panel switch that got the player here.
  ui.clearSelection();
  ui.setHighlight((store.snapshot?.buildings ?? [])
    .filter((b) => b.defId === defId)
    .map((b) => ({ kind: 'building' as const, id: b.id })));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/dock/EconomyPanel.vue tests/app/dock-panels.test.ts
git commit -m "A chain stage lights up every building it stands for"
```

---

## Task 11: The Attention panel

**Files:**
- Create: `src/app/components/dock/AttentionPanel.vue`
- Test: extend `tests/app/dock-panels.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import AttentionPanel from '../../src/app/components/dock/AttentionPanel.vue';

describe('AttentionPanel', () => {
  it('selects the building a row names', async () => {
    const stalled = makeSnapshot({ buildings: [makeBuilding(4, { defId: 'sawmill', state: 'outputFull' })] });
    const { wrapper, ui } = mountPanel(AttentionPanel, stalled);
    await wrapper.get('[data-test="attention-full-4"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'building', id: 4 });
  });

  it('clears a standing selection when a plural row is clicked', async () => {
    const homeless = makeSnapshot({ homeless: 1, buildings: [makeBuilding(4)], colonists: [makeWorker(2)] });
    const { wrapper, ui } = mountPanel(AttentionPanel, homeless);
    ui.selectBuilding(4); // the dock keeps this across a panel switch — hence the risk
    await wrapper.get('[data-test="attention-homeless"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'none' });
    expect(ui.highlight).toEqual([{ kind: 'colonist', id: 2 }]);
  });

  it('leaves a runway row inert — it does not even deselect', async () => {
    const draining = makeSnapshot({
      stockpile: { ...stockedWith({ bread: 20 }), bread: { stock: 20, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    });
    const { wrapper, ui } = mountPanel(AttentionPanel, draining);
    ui.selectBuilding(4);
    await wrapper.get('[data-test="attention-runway-bread"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'building', id: 4 }); // untouched
    expect(ui.highlight).toEqual([]);
  });

  it('says so when nothing needs attention', () => {
    const fine = makeSnapshot({ buildings: [makeBuilding(1, { workers: 2, workerSlots: 2, state: 'producing' })] });
    const { wrapper } = mountPanel(AttentionPanel, fine);
    expect(wrapper.get('[data-test="attention-empty"]').text()).toContain('Nothing needs attention');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: FAIL — cannot resolve `AttentionPanel.vue`.

- [ ] **Step 3: Write the panel**

```vue
<script setup lang="ts">
import { useGameStore } from '../../stores/game-store';
import { useUiStore } from '../../stores/ui-store';
import type { AttentionRow } from '../../stores/game-store';

const store = useGameStore();
const ui = useUiStore();

/*
 * The three outcomes of §2.3's table, in the order the table gives them.
 *
 * A plural row CLEARS the selection: the table calls its result "highlights
 * that set; selects nothing", and the dock deliberately keeps a selection
 * alive across a panel switch — so without this, selecting a building and then
 * clicking "3 colonists have no bed" would leave the building selected and the
 * Inspector pointed at it while the pulse says otherwise.
 *
 * An inert row does nothing AT ALL, which is not the same as clearing: a
 * runway warning naming bread has no business deselecting the sawmill the
 * player is looking at.
 */
function activate(row: AttentionRow) {
  if (row.subject !== null) {
    ui.setHighlight([]);
    ui.select(row.subject);
    return;
  }
  if (row.highlight.length === 0) return;
  ui.clearSelection();
  ui.setHighlight([...row.highlight]);
}
</script>

<template>
  <ul class="obsisim-attention" data-test="attention">
    <li v-for="row in store.attention" :key="row.id" :data-test="`attention-${row.id}`"
      :class="row.severity === 'danger' ? 'obsisim-negative' : 'obsisim-warning'" @click="activate(row)">
      {{ row.message }}
    </li>
    <li v-if="store.attention.length === 0" data-test="attention-empty">Nothing needs attention.</li>
  </ul>
</template>
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire all five panels into the dock**

In `WorldScreen.vue`, render each panel behind its `ui.panel` value inside the
`<aside>` — and put the **tab strip outside that conditional**, always mounted:

```vue
    <!-- OUTSIDE the v-if. These five buttons are what replaced the old nav
         strip, so they cannot live inside the panel body they open: with no
         panel yet chosen there would be nothing to click, and the only route
         to Colony, Population, Economy or Attention would be selecting a map
         subject first to force the Inspector open. -->
    <nav class="obsisim-dock-tabs">
      <button v-for="p in DOCK_PANELS" :key="p" :data-test="`dock-tab-${p}`"
        :class="{ 'is-active': ui.panel === p }" @click="ui.openPanel(p)">{{ DOCK_LABELS[p] }}</button>
    </nav>
    <aside v-if="ui.panel" class="obsisim-dock" data-test="dock">
      <InspectorPanel v-if="ui.panel === 'inspector'" />
      <ColonyPanel v-else-if="ui.panel === 'colony'" />
      <PopulationPanel v-else-if="ui.panel === 'population'" />
      <EconomyPanel v-else-if="ui.panel === 'economy'" />
      <AttentionPanel v-else />
      <button data-test="dock-close" aria-label="Close panel" @click="ui.closeDock()">✕</button>
    </aside>
```

`DOCK_PANELS` and `DOCK_LABELS` go in `src/app/labels.ts`, keyed by the
`DockPanel` union so a sixth panel is a compile error rather than an unlabelled
tab — the same rule `BUILDING_STATE_LABELS` follows.

Add to `tests/app/world-screen.test.ts`:

```ts
  it('offers every panel from a closed dock', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    expect(ui.panel).toBe(null);
    expect(wrapper.find('[data-test="dock"]').exists()).toBe(false);
    for (const panel of ['colony', 'population', 'economy', 'attention'] as const) {
      await wrapper.get(`[data-test="dock-tab-${panel}"]`).trigger('click');
      expect(ui.panel).toBe(panel);
    }
    await wrapper.get('[data-test="dock-close"]').trigger('click');
    expect(ui.panel).toBe(null);
    expect(wrapper.get('[data-test="dock-tab-attention"]').isVisible()).toBe(true);
    wrapper.unmount();
  });
```

- [ ] **Step 6: Commit**

```bash
git add src/app/components/dock src/app/views/WorldScreen.vue tests/app/dock-panels.test.ts
git commit -m "The problem list, and the dock gets its five panels"
```

---

## Task 12: Two routes, the Ledger, and table Move

**Files:**
- Modify: `src/app/router.ts`, `src/app/App.vue`, `src/app/views/BuildingsView.vue`
- Create: `src/app/views/LedgerView.vue`
- Test: `tests/app/ledger-view.test.ts`, extend `tests/app/buildings-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/app/ledger-view.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import LedgerView from '../../src/app/views/LedgerView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot } from './fixtures';

describe('LedgerView', () => {
  it('carries a control for every engine verb, move included', async () => {
    const engine = { dispatch: vi.fn() };
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(
      makeSnapshot({ idleAdults: 1, buildings: [makeBuilding(1)] }),
      { paused: true, speed: 1, error: null },
    );
    const wrapper = mount(LedgerView, { global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } } });
    for (const test of ['construct-farm', 'assign-1', 'unassign-1', 'demolish-1', 'move-1', 'assign-hauler', 'unassign-hauler', 'recruit']) {
      expect(wrapper.find(`[data-test="${test}"]`).exists()).toBe(true);
    }
  });
});
```

Add to `tests/app/buildings-view.test.ts`:

```ts
  it('moves a building to typed coordinates', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({ buildings: [makeBuilding(1)] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('9');
    await wrapper.get('[data-test="move-row-1"]').setValue('4');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 9, row: 4 } });
  });

  it('records the coordinates as submitted, not as later edited', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({ buildings: [makeBuilding(1)] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('9');
    await wrapper.get('[data-test="move-row-1"]').setValue('4');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    // The queue holds the object it was given; editing after the click must not
    // reach back into an already-enqueued command.
    await wrapper.get('[data-test="move-col-1"]').setValue('1');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 9, row: 4 } });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit tests/app/ledger-view.test.ts tests/app/buildings-view.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Rewire the router, write the Ledger, add table Move**

`src/app/router.ts`:

```ts
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import WorldScreen from './views/WorldScreen.vue';
import LedgerView from './views/LedgerView.vue';

export function createGameRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'world', component: WorldScreen },
      { path: '/ledger', name: 'ledger', component: LedgerView },
    ],
  });
}
```

`App.vue`: drop the `tabs` array and the `<nav>`; add one Ledger toggle to the top bar area; **keep** `<keep-alive include="WorldScreen">` (the include name changes with the component) — the Ledger round trip is the one remaining unmount path and this is what stops it tearing down WebGL.

`LedgerView.vue` composes `DashboardView`, `BuildingsView`, `PopulationView` and `EconomyView` in sequence and owns no figures of its own.

`BuildingsView.vue` gains two number inputs and a Move button per row.

The handler **copies** the coordinates rather than handing over the reactive
object, because `GameEngine.dispatch` passes straight to `CommandQueue.push`,
which stores the reference (`resources.ts`) — nothing in the chain clones. Hand
over `moveTargets[b.id]` itself and a player can click Move for (9, 4), edit
either input before the next tick drains the queue, and watch the building go
somewhere they did not ask for. While paused, that window is unbounded:

```ts
function moveTo(buildingId: number) {
  const { col, row } = moveTargets[buildingId];
  engine.dispatch({ type: 'moveBuilding', buildingId, to: { col, row } });
}
```


```vue
          <td>
            <input :data-test="`move-col-${b.id}`" v-model.number="moveTargets[b.id].col" type="number" min="0" />
            <input :data-test="`move-row-${b.id}`" v-model.number="moveTargets[b.id].row" type="number" min="0" />
            <!-- Deliberately worse than dragging a ghost across a map: this
                 exists so the fallback is complete (spec §2.2), not so it is
                 nice. Disabled for a site, matching the Inspector and the
                 engine's own refusal. -->
            <button :data-test="`move-${b.id}`" :disabled="b.constructionTicks > 0"
              @click="moveTo(b.id)">Move</button>
          </td>
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Route to the Ledger on renderer failure**

In `App.vue`, watch **`useUiStore().rendererFailure`** — not an event from
`WorldScreen`, which is rendered by the router and has no template handle in
`App.vue` — and on a non-null value `router.push('/ledger')` while rendering a
persistent banner naming the failure:

```ts
watch(() => ui.rendererFailure, (failure) => {
  if (failure !== null) void router.push('/ledger');
});
``` Add to `tests/app/world-screen.test.ts`:

```ts
  it('routes to the ledger on a post-boot fatal, not only on a boot failure', async () => {
    /* mount with a succeeding factory, invoke the captured onFatal callback,
       assert the route is '/ledger' and the banner is still rendered */
  });
```

Both cases go through `ui.rendererFailure`, so the App-level test mounts the
real router with a fake renderer factory and asserts the route and the banner:

```ts
  it('routes to the ledger on a boot failure and on a post-boot fatal', async () => {
    for (const trigger of ['boot', 'post-boot'] as const) {
      const { renderer, factory } = makeFakeFactory(trigger === 'boot');
      const { router } = await mountApp(factory);
      if (trigger === 'post-boot') {
        const report = (renderer!.onFatal as ReturnType<typeof vi.fn>).mock.calls[0][0] as (m: string) => void;
        report('context lost');
      }
      await flushPromises();
      expect(router.currentRoute.value.path).toBe('/ledger');
      expect(document.querySelector('[data-test="renderer-banner"]')).not.toBeNull();
    }
  });
```

`makeFakeFactory(shouldThrow)` returns a factory that either throws on call or
returns a working fake — the two paths reach `ui.rendererFailure` differently
and both must land on the Ledger. Criterion 3 requires both, and the
throwing-factory case cannot reach `onFatal` at all, because that callback is
registered only after the factory succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A src/app tests/app
git commit -m "Five routes become two, and the Ledger finally learns to move a building"
```

---

## Task 13: The visual language

**Files:**
- Modify: `styles.css`, `src/app/world/theme.ts`
- Create: `src/app/icons.ts`, `src/app/components/Icon.vue`
- Test: `tests/app/world-theme.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/app/world-theme.test.ts` a case asserting `resolveWorldTheme` reads the new custom properties (`--obsisim-state-starved` and friends) and falls back to today's literals when they are absent.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit tests/app/world-theme.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the tokens and the sprite**

In `styles.css`, add a token block on `.obsisim` naming every colour `theme.ts` currently resolves, then the shell layout (grid for `.obsisim-world-screen`, `@container` queries for `.is-narrow`), the type scale, `font-variant-numeric: tabular-nums` on `.obsisim-table td` and the strip, and three transitions behind `@media (prefers-reduced-motion: no-preference)`. No `!important` anywhere.

`src/app/icons.ts` is `export const ICONS: Record<IconName, string>` of path `d` attributes; `Icon.vue` renders `<svg viewBox="0 0 24 24"><path :d="ICONS[name]" fill="currentColor" /></svg>`. Replace the chrome emoji in `TopBar.vue` and `ResourceStrip.vue`; leave the canvas legend's emoji alone.

- [ ] **Step 4: Run the tests and the CSS gate**

Run: `npm test && npm run check:css`
Expected: PASS, and the `!important` baseline still empty.

- [ ] **Step 5: Verify both themes by eye**

Run: `npm run test-build`, open the repo as a vault, and check the world screen in Obsidian's light and dark themes. `theme.ts` carries hardcoded fallbacks, so this is a check rather than an assumption.

- [ ] **Step 6: Commit**

```bash
git add styles.css src/app/icons.ts src/app/components/Icon.vue src/app/world/theme.ts src/app/components/TopBar.vue tests/app/world-theme.test.ts
git commit -m "One palette, two renderers — and numbers that stop jittering"
```

---

## Task 14: Coverage floors, docs, and the gates

**Files:**
- Modify: `vitest.config.ts`, `README.md`
- Create/modify: `docs/requirements/` (new epic, feature, PBIs; supersede Table Parity)

- [ ] **Step 1: Add the floors**

In `vitest.config.ts`, replace the deferral comment and add:

```ts
        // Increment 11 is the "later" this comment used to defer to: it roughly
        // doubles the view layer, and it is the one increment where the views
        // ARE the product. 80/70 rather than the engine's 90/85 because
        // renderer-adjacent branches are not honestly reachable in jsdom, and a
        // floor set where it cannot be met is a floor that gets loosened later.
        'src/app/components/**': { statements: 80, branches: 70, functions: 80, lines: 80 },
        'src/app/views/**': { statements: 80, branches: 70, functions: 80, lines: 80 },
```

Leave `src/app/world/**` unfloored: `renderer.ts` cannot be imported by unit tests at all, so a floor there would be unmeetable by construction.

- [ ] **Step 2: Run coverage**

Run: `npm run test:coverage`
Expected: PASS. If a view is short, add the missing case — do **not** lower the floor.

- [ ] **Step 3: Update the README**

Add the missing `## Increment 8 — Storehouse Transfer`, `## Increment 9 — Construction as Work` and `## Increment 10 — A Build Queue That Converges` sections from their specs, then a `## Increment 11 — The World Screen` section. Rewrite the Increment 3 line that promises *"no-WebGL play stays whole"* to state the §1.2 fallback contract instead. Add the increment 8–11 spec and plan links to the Documentation list.

- [ ] **Step 4: Backlog surgery**

File OBS-11-01 if it is not already present:
`docs/issues/2026-08-16-a-grown-map-shrinks-below-readability.md` — the grown-map
readability limitation this increment accepts rather than fixes. It is written
already; check it is parented and ordered consistently with its siblings.


Create `docs/requirements/Interface and Play.md` (Epic), `The World Screen.md` (Feature), and PBIs for the shell, the Inspector and its verbs, the panels, the Ledger fallback and the visual language. Mark `Per-View Coverage Floors.md` Done. Supersede `Table Parity for Placement.md` with a new PBI carrying the fallback contract. Follow the frontmatter conventions in `docs/README_PRODUCT_BACKLOG.md` — `type`, `parent` as `"[[Note name]]"`, `order` 10 apart.

- [ ] **Step 5: Run the full gate**

Run: `npm run check:all`
Expected: PASS — lint, loc, css, quality, test-projects, typecheck, test, balance, build, artifacts.

Then run the smoke harness **explicitly**, because `check:all` does not include
it and criterion 11 requires it — it is also the only check that drives the real
Excalibur renderer at all, and this increment changed it:

```bash
npm i --no-save playwright-core   # if not already present; see scripts/world-smoke.mjs
npm run smoke:world
```

Expected: PASS. A failure here is a real-renderer regression that every other
gate is blind to.

Then confirm criterion 12 explicitly:

```bash
git diff --stat $(git merge-base origin/main HEAD)...HEAD -- src/engine src/shared
```

Expected: **empty output.** Anything here means the increment reached into the engine and the design needs re-examining rather than the criterion waiving.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Document and close out increment 11"
```

---

## Self-Review

**Spec coverage.** §2.1 → Tasks 6, 12 (and, for the camera, deliberately nothing — the cut is the requirement, and Task 3 step 3 says so where an implementer would otherwise reach for `fitCamera`). §2.2 → Tasks 7, 8, 9, 12. §2.3 → Tasks 1, 3, 9, 10, 11. §2.4 → Task 2. §2.5 → Tasks 6, 12. §2.6 → Tasks 1, 4, 5, 6, 12. §2.7 → Tasks 8–11 (panels reuse `PopulationSummary` and store getters rather than re-deriving). §2.8 → Task 14. §2.9 → Task 13. Criteria 1–2 → Tasks 7–9, 12. 3 → Task 12 step 5. 4 → Tasks 5, 9, 10, 11. 5 → Tasks 6, 12. 6 → Tasks 1, 6. 7 → Task 6. 8–11 → Task 14. 12 → Task 14 step 5. **No gaps.** The one the previous draft had — criterion 8's grown-map assertions having no unit-test home, because `renderer.ts` cannot be imported by tests — is gone with the criterion: that work is OBS-11-01's, and its untestability is one of the reasons it was cut.

**Placeholder scan.** Task 12 step 5 and Task 13 step 1/step 3 describe tests and CSS without full code. Task 12 step 5 says so explicitly and instructs the implementer to write the test fully before implementing; Task 13's CSS is genuinely open-ended design work rather than a behaviour with an assertion. Both are weaker than the rest of the plan and should be read as such.

**Type consistency.** `Selection`, `DockPanel` and `Mode` are defined once in Task 1 and imported everywhere after. `AttentionRow` is defined in Task 2 and consumed in Task 11. The renderer seam's four new methods are named identically in Tasks 3, 5 and the fakes in Tasks 5 and 6. `data-test` names are shared between Task 6's `WorldScreen` assertions and the components that satisfy them in Tasks 7–11.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-16-increment-11-the-world-screen.md`.
