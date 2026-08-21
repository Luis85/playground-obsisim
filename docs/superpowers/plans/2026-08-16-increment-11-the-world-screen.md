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

  // Correction A: an armed move is the ONLY mode the dock's dismissal rule
  // touches. `place` is armed from the rail, which is not part of the dock
  // and stays on screen regardless of which panel is open, so opening a panel
  // or closing the dock must leave it alone.
  it('an armed place survives opening a panel', () => {
    const ui = useUiStore();
    ui.armPlace('farm');
    ui.openPanel('colony');
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' });
  });

  it('an armed place survives closing the dock', () => {
    const ui = useUiStore();
    ui.armPlace('farm');
    ui.closeDock();
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' });
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

  it('drops a standing highlight when a subject is selected', () => {
    const ui = useUiStore();
    ui.setHighlight([{ kind: 'building', id: 2 }, { kind: 'building', id: 3 }]);
    ui.selectColonist(9);
    expect(ui.highlight).toEqual([]);
  });

  it('keeps the highlight when the selection is cleared, so a plural row can set one', () => {
    const ui = useUiStore();
    ui.selectBuilding(1);
    ui.clearSelection();
    ui.setHighlight([{ kind: 'colonist', id: 4 }]);
    expect(ui.highlight).toEqual([{ kind: 'colonist', id: 4 }]);
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

  // Correction B: a non-none selection cancels an armed place. Once panel
  // rows can select things (a later task), arming the rail's palette and then
  // clicking an Attention row would otherwise leave the palette armed behind
  // a live selection and Inspector — the same double-claim hazard armPlace
  // itself guards against, reached from the other direction.
  it('selecting a building cancels an armed place, and the selection stands', () => {
    const ui = useUiStore();
    ui.armPlace('farm');
    ui.selectBuilding(7);
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'building', id: 7 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/app/ui-store.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/app/stores/ui-store"`.

- [ ] **Step 3: Write the store**

Two corrections apply to the store below, both about what an outgoing
`select()` or dock action is allowed to cancel:

- **`openPanel` and `closeDock` cancel a `move`, never a `place`.** Spec §2.1's
  dismissal rule is written about the Inspector specifically ("dismissing the
  Inspector cancels the move"). A `place` mode is armed from the rail, which
  is not part of the dock and stays on screen regardless of which panel is
  open, so opening the Colony panel to check stock — or closing the dock —
  must not disarm a build the player can still see armed. Both actions gate
  on `this.mode.kind === 'move'` rather than idling unconditionally.
- **A non-`none` selection cancels an armed `place`.** Once later tasks let
  panel rows select things (an Attention row selecting a building, a
  Population row selecting a colonist), arming the rail's palette and then
  clicking such a row would select a subject and open the Inspector while the
  palette stayed armed — the double-claim hazard `armPlace`'s own comment
  names, reached from the other direction. `select()` therefore also idles a
  `place` mode whenever `next.kind !== 'none'`. `armPlace` still calls
  `select({ kind: 'none' })` before arming, so it does not cancel itself.

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
     *
     * Two outgoing modes are gated here, for two different reasons. An armed
     * `move` belongs to the selection it came from, so ANY change away from
     * that building — Escape, empty ground, a different subject — cancels it;
     * that is spec §2.1's invariant proper. An armed `place`, by contrast,
     * belongs to the rail and does not care what panel is open or what used
     * to be selected — but it still cannot survive a selection landing on
     * top of it. `armPlace` clears the selection before arming precisely
     * because a selection under an armed palette would double-claim canvas
     * clicks (see its own comment below); once later tasks let panel rows
     * select things, clicking an Attention or Population row while the rail
     * is armed would open exactly that route from the other direction — a
     * selection appearing WHILE `place` is still armed, rather than the
     * other way around. So a `place` mode is cancelled the moment `next` is
     * anything but `none`, not conditioned on which subject it names.
     */
    select(next: Selection) {
      const armedMove = movedBuilding(this.mode);
      const stillArmed = armedMove !== null && next.kind === 'building' && next.id === armedMove;
      if (armedMove !== null && !stillArmed) this.mode = { kind: 'idle' };
      if (this.mode.kind === 'place' && next.kind !== 'none') this.mode = { kind: 'idle' };
      this.selection = next;
      // A selection and a highlight are alternatives, never both (§2.3's
      // table gives every row one result). Enforced HERE rather than in each
      // caller: AttentionPanel's single-subject path already cleared the pulse
      // by hand, and Population rows, Inspector occupant rows and the canvas
      // did not — so a stage highlight survived alongside a new selection.
      // Only the non-none branch clears, which is what lets the plural flow
      // (clearSelection, then setHighlight) still work.
      if (next.kind !== 'none') {
        this.panel = 'inspector';
        this.highlight = [];
      }
    },
    selectBuilding(id: number) { this.select({ kind: 'building', id }); },
    selectColonist(id: number) { this.select({ kind: 'colonist', id }); },
    clearSelection() { this.select({ kind: 'none' }); },

    /**
     * Switching panel keeps the selection (§2.1's dock rule) and therefore
     * cannot ride on `select` above — but it does dismiss the Inspector, and
     * an armed MOVE must not outlive the Inspector that armed it.
     *
     * A `place` mode is armed from the rail, not the dock: the rail stays on
     * screen no matter which panel is open, so a player checking their stock
     * on the Colony panel mid-placement has not dismissed anything the
     * palette depends on. Gating on `mode.kind === 'move'` rather than
     * idling unconditionally is what tells those two cases apart.
     */
    openPanel(panel: DockPanel) {
      if (panel !== this.panel && this.mode.kind === 'move') this.mode = { kind: 'idle' };
      this.panel = panel;
    },
    closeDock() {
      if (this.mode.kind === 'move') this.mode = { kind: 'idle' };
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
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/ui-store.ts tests/app/ui-store.test.ts
git commit -m "The UI store, and the two places an armed mode can be cancelled"
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
  `interface AttentionRow { id: string; severity: 'warn' | 'danger'; message: string; subject: Selection | null; highlight: Selection[] }`,
  and getter `starvingCount: number` (the colonists whose starvation clock is
  running — Task 12's `PopulationSummary` cell reads this same getter rather
  than deriving its own count, per §2.7).

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
Expected: PASS, 9 tests. (The block above has 9 `it`s, not 14 — the singular
message branches, the sort order, and `starvingCount` still need their own
cases, added during implementation.)

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

- [ ] **Step 3b: Give the smoke harness a phase per new branch**

This is not optional, and it is the only place these branches are ever drawn.
`scripts/world-smoke-harness/main.ts` calls `setSelection(1)` **bundled with a
ghost in one phase** and calls `setHighlight` nowhere at all — so simply
retyping that one call to the discriminated argument would leave the colonist
branch and the whole of `setHighlight` absent or no-op while `smoke:world` and
every fake-renderer unit test stayed green. Unit tests cannot cover this:
`renderer.ts` is never imported by them.

Follow the harness's own convention, stated in its comments — **one change per
phase, so each check is discriminating** — and append these before the
`dispose()` phase (everything after it draws nothing).

Two traps, both of which make a phase prove nothing:

- **Phase 35's scene has no colonists.** `constructionScene` is a mill and
  nothing else, so selecting colonist 12 there draws nothing *even in a correct
  renderer* and the first comparison fails for the wrong reason. Sync a scene
  that contains the colonist first — `haulScene` already carries worker 12 and
  building 1.
- **Clearing a selection and adding a highlight in one phase is two changes.**
  The frame differs from its predecessor because the ring vanished, so the
  comparison passes with `setHighlight`'s building branch missing entirely. The
  cleared state needs its own baseline frame.

```ts
  // 36: a scene with worker 12 and building 1 in it. A whole scene swap is a
  // many-pixel change, so this frame carries no check of its own — the same
  // role phases 20, 24, 27 and 29 already play.
  () => renderer.sync(haulScene(10, {})),
  // 37: ONE change — a colonist ring appears. The building-ring phase earlier
  // bundles its selection with a ghost, so only an isolated frame can prove
  // the colonist branch draws anything at all.
  () => renderer.setSelection({ kind: 'colonist', id: 12 }),
  // 38: ONE change — the ring moves from the colonist to a building.
  () => renderer.setSelection({ kind: 'building', id: 1 }),
  // 39: ONE change — the ring clears. This is also the BASELINE the two
  // highlight frames are measured against, which is why it is its own phase.
  () => renderer.setSelection({ kind: 'none' }),
  // 40: ONE change — a building pulse appears against that cleared baseline.
  () => renderer.setHighlight([{ kind: 'building', id: 1 }]),
  // 41: ONE change — the pulse moves to a colonist, the second setHighlight
  // branch, which phase 40 cannot reach.
  () => renderer.setHighlight([{ kind: 'colonist', id: 12 }]),
  // 42: ONE change — the pulse clears.
  () => renderer.setHighlight([]),
```

**The runner does not assert these on its own.** `scripts/world-smoke.mjs`
drives *fixed indices* by hand — `await step(19)`, `await step(20)`, … each
followed by explicit `shot()` comparisons — and has no generic
phase-difference loop. Two consequences, both of which break silently:

- `await step(36)` **is the `dispose()` phase today.** Inserting five phases
  before it makes 36 the first new selection frame, so `dispose()` is never
  invoked and the runner's teardown assertions never run.
- A phase nothing compares is a phase that proves nothing.

So the same pass edits the runner: renumber the disposal step to `step(43)`,
and add a comparison per new frame, in the house style — one change, one
assertion, each named for what it would catch:

```js
await step(36); // a scene carrying worker 12 and building 1 — settle before measuring
const sceneBaseline = await shot();

await step(37); // ONE change: a colonist ring appears
const colonistRing = await shot();
assertDiffers(sceneBaseline, colonistRing, 'a colonist selection draws no ring');

await step(38); // ONE change: the ring moves from the colonist to a building
const buildingRing = await shot();
assertDiffers(colonistRing, buildingRing, 'the ring did not move to the building');

await step(39); // ONE change: the ring clears — and this is the highlight baseline
const noRing = await shot();
assertDiffers(buildingRing, noRing, 'a selection ring never clears');

await step(40); // ONE change: a building pulse against that cleared baseline
const buildingPulse = await shot();
assertDiffers(noRing, buildingPulse, 'setHighlight draws nothing on a building');

await step(41); // ONE change: the pulse moves to a colonist
const colonistPulse = await shot();
assertDiffers(buildingPulse, colonistPulse, 'setHighlight has no colonist branch');

await step(42); // ONE change: the pulse clears
const noPulse = await shot();
assertDiffers(colonistPulse, noPulse, 'a highlight never clears');

await step(43); // dispose()
```

Use whatever the file's existing comparison helper is called — read it first;
the shape above is the pattern, not necessarily the name. Update the existing
`setSelection(1)` / `setSelection(null)` calls to the discriminated form in the
same pass.

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
import { makeBuilding, makeSnapshot, stockedWith } from './fixtures';

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
    // col 2 sits inside the CAMP_COLS=3 idle-camp band, always unbuildable
    // regardless of occupancy — col 8 is a genuinely free buildable tile.
    interaction.setHoverTile({ col: 8, row: 4 });
    expect(interaction.ghost.value).toEqual({ defId: 'farm', col: 8, row: 4, valid: true });
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
    expect(interaction.clickTile({ col: 8, row: 4 }))
      .toEqual({ type: 'constructBuilding', buildingDefId: 'farm', at: { col: 8, row: 4 } });
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' }); // repeat placement
  });

  it('refuses a placing click on an occupied tile', () => {
    const { ui, interaction } = setup();
    ui.armPlace('farm');
    expect(interaction.clickTile({ col: 5, row: 5 })).toBe(null);
  });

  // Increment 10 made ordering a request rather than a claim: a queued
  // site's outstanding demand must NOT invalidate the placement ghost on an
  // otherwise-empty tile. The fixture is a house already queued against
  // exactly its own cost, with the stockpile showing that exact amount
  // already owed (`constructionNeeds`) — the strongest case for the OLD
  // affordability-gated rule, and therefore the sharpest regression check
  // for its removal: if `tileValid` still consulted affordability anywhere,
  // this is the fixture that would catch it.
  it("a queued site's outstanding demand no longer invalidates the placement ghost", () => {
    setActivePinia(createPinia());
    useGameStore().ingest(makeSnapshot({
      buildings: [
        makeBuilding(7, { defId: 'bakery', col: 6, row: 3 }),
        makeBuilding(8, {
          defId: 'house', state: 'underConstruction', constructionTicks: 20,
          constructionNeeds: { wood: 15, planks: 5 }, // the site's whole cost, undelivered
        }),
      ],
      stockpile: stockedWith({ wood: 15, planks: 5 }), // exactly one house's worth, all already owed
    }), { paused: true, speed: 1, error: null });
    const ui = useUiStore();
    const interaction = useWorldInteraction();
    ui.armPlace('house');
    interaction.setHoverTile({ col: 8, row: 4 });
    expect(interaction.ghost.value).toEqual({ defId: 'house', col: 8, row: 4, valid: true });
  });

  // `tileValid`'s own gate: occupancy is the only thing checked, for both
  // modes alike. The fixture is a genuinely EMPTY ledger (every RESOURCE_IDS
  // entry at 0 via `stockedWith()`), not a rich snapshot that happens to
  // cover the def's cost — a rich snapshot would pass this assertion whether
  // or not the affordability gate still existed, which is exactly the
  // false-positive an incomplete regression check would miss.
  it('accepts the tile for an unaffordable def', () => {
    setActivePinia(createPinia());
    useGameStore().ingest(makeSnapshot({
      buildings: [makeBuilding(7, { defId: 'bakery', col: 6, row: 3 })],
      stockpile: stockedWith(), // every resource at 0
    }), { paused: true, speed: 1, error: null });
    const ui = useUiStore();
    const interaction = useWorldInteraction();
    ui.armPlace('forester');
    interaction.setHoverTile({ col: 8, row: 4 });
    expect(interaction.ghost.value).toEqual({ defId: 'forester', col: 8, row: 4, valid: true });
    // The predicate alone proves nothing if the click handler still refused
    // separately — pin the returned command too.
    expect(interaction.clickTile({ col: 8, row: 4 }))
      .toEqual({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 8, row: 4 } });
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

  it("a move's own tile counts as occupied, matching the engine's refusal", () => {
    const { ui, interaction } = setup();
    ui.selectBuilding(1);
    ui.armMove(1);
    expect(interaction.clickTile({ col: 5, row: 5 })).toBe(null);
  });

  it('forgets the hovered tile when the mode returns to idle, however it got there', () => {
    const { ui, interaction } = setup();
    ui.armPlace('farm');
    interaction.setHoverTile({ col: 2, row: 2 });
    expect(interaction.ghost.value).not.toBe(null);

    ui.escape(); // cancels the mode without touching this composable
    expect(interaction.hoverTile.value).toBe(null);

    // Re-arming from a focused palette button moves no pointer, so a stale
    // tile here would draw a ghost where the pointer no longer is.
    ui.armPlace('farm');
    expect(interaction.ghost.value).toBe(null);
  });

  it('swaps the ghost in place when the armed definition changes over a parked pointer', () => {
    const { ui, interaction } = setup();
    ui.armPlace('forester');
    interaction.setHoverTile({ col: 8, row: 4 });
    expect(interaction.ghost.value).toEqual({ defId: 'forester', col: 8, row: 4, valid: true });
    // No pointer event happens between the two arms (a focused palette button
    // re-arming by keyboard) — the ghost must follow from the mode change alone.
    ui.armPlace('farm');
    expect(interaction.ghost.value).toEqual({ defId: 'farm', col: 8, row: 4, valid: true });
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
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { isTileBuildable } from '../../shared/placement';
import type { Command } from '../../shared/commands';
import { useGameStore } from '../stores/game-store';
import { useUiStore, type Mode } from '../stores/ui-store';
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
    const mode: Mode = ui.mode;
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

  /*
   * A remembered tile must not outlive the mode that used it.
   * `WorldView.cancelMode()` cleared `lastTile` alongside the mode, in one
   * function, because the two were owned by the same component. This split
   * separates them — the mode lives in the store now — so EVERY store path
   * that returns to idle (Escape, a panel switch, a selection change, a
   * completed move) would otherwise leave the tile behind. Arm from a focused
   * palette button by keyboard, with no pointer event to refresh it, and the
   * ghost reappears at a position the pointer left long ago.
   *
   * Watched rather than fixed at each cancel site, for the same reason the
   * cancel invariant lives in the selection setter: there are five ways in and
   * only one of them is this composable's own.
   *
   * `flush: 'sync'` is required, not merely convenient. `hoverTile` and the
   * mode were one fact that WorldView's `cancelMode()` used to update in one
   * function — `mode.value = idle; lastTile.value = null; setGhost(null)` in
   * three consecutive lines — precisely so the two could never be observed
   * apart. `ghost` above is a computed over `hoverTile`, so with the default
   * `pre` flush there is a window, between the store going idle and the
   * scheduler running this watcher, in which the mode already reads idle but
   * `hoverTile` (and therefore `ghost`, for a `move`'s own building only —
   * `ghostDefId` already reads null for `place` once idle) still holds the
   * stale tile. `sync` closes that window instead of merely narrating it.
   */
  watch(() => ui.mode.kind, (kind) => {
    if (kind === 'idle') hoverTile.value = null;
  }, { flush: 'sync' });

  function clickTile(tile: Tile | null): Command | null {
    const mode: Mode = ui.mode;
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
Expected: PASS, 13 tests.

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

  // Deactivation stops the clock; only a real unmount releases the WebGL
  // context. Nothing else asserts this — Task 12's router test deliberately
  // asserts dispose was NOT called — so without this case an implementation
  // that omits onBeforeUnmount cleanup passes every prescribed test and leaks
  // an Excalibur engine on every close and reopen of the Obsidian view.
  it('disposes the renderer on final unmount, not on deactivate', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    expect(renderer.dispose).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
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
- Create: `src/app/views/WorldScreen.vue`, `src/app/components/ResourceStrip.vue`
- Delete: `src/app/views/WorldView.vue`, `tests/app/world-view.test.ts`
- Test: `tests/app/world-screen.test.ts`, `tests/app/resource-strip.test.ts`

**Interfaces:**
- Consumes: `WorldStage` (Task 5), `useUiStore` (Task 1), `BuildPalette`, `WorldLegend`, `ENGINE_KEY` (the strip's hauler verbs).
- Produces: `ResourceStrip`, which this shell imports — hence built here rather than in Task 8.
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
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot } from './fixtures';

function makeFake(): WorldRenderer {
  return {
    sync: vi.fn(), pick: vi.fn(() => null), tileAt: vi.fn(() => null),
    setGhost: vi.fn(), setSelection: vi.fn(), setHighlight: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
}

function mountScreen() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  // Seeded BEFORE mount, deliberately. In production `App.vue` gates the
  // router view on `store.snapshot`, so nothing downstream ever renders
  // against null — but mounting WorldScreen directly skips that gate, and
  // several assertions read live figures. ResourceStrip guards on
  // store.snapshot in its own right, so this is convenience, not a crutch.
  useGameStore(pinia).ingest(
    makeSnapshot({ idleAdults: 1, buildings: [makeBuilding(1)] }),
    { paused: true, speed: 1, error: null },
  );
  return mount(WorldScreen, {
    attachTo: document.body, // window keydown listeners need a live document
    global: {
      plugins: [pinia],
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
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(makeSnapshot({ idleAdults: 1 }), { paused: true, speed: 1, error: null });
    mount(Harness, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
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

  // Deliberately NOT seeded, and safe because ResourceStrip guards on
  // store.snapshot. A component that throws against a null snapshot will throw
  // in some context nobody has thought of yet; seeding every mount hides that
  // rather than fixing it.
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

- [ ] **Step 3: Write `ResourceStrip` first — the shell imports it**

`WorldScreen` renders `ResourceStrip`, and Step 1's test asserts
`data-test="resource-strip"` exists. So this component cannot wait for Task 8:
the module would not resolve, and this task could not reach a passing test at
all. It is small, and it carries the two hauler verbs, so it belongs with the
shell that shows them.

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
  return {
    wrapper: mount(ResourceStrip, { global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } } }),
    engine,
  };
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

Run it to watch it fail (`npx vitest run --project unit tests/app/resource-strip.test.ts` — cannot resolve `ResourceStrip.vue`), then write the component.

`ResourceStrip.vue` renders one chip per `RESOURCE_IDS` entry — glyph, stock,
and `~Nt` when `store.runways[id]` is defined — with class `obsisim-negative` at
or under 30 ticks, plus the hauler pair. Root element carries
`data-test="resource-strip"`.

The hauler pair is **not** lifted verbatim from `DashboardView`: that version
explains a disabled `+` with a `title` alone, and §2.2 requires a refused
control to state its reason where the player is looking — the same rule the
Inspector's staffing and Move controls follow.

**Guard the whole component on `store.snapshot`**, the way every other view in
this codebase already does — `BuildingsView`, `DashboardView`, `EconomyView`,
`PopulationView`, `PopulationSummary` and `TopBar` all open with
`v-if="store.snapshot"`. `store.snapshot!` is a lie anywhere the router gate is
absent, and mounting a component directly in a test is exactly that. Seeding
each test that mounts it is a fix per call site, and there is always another
call site; this is a fix per component, and it is the house style regardless.

```vue
<template>
  <div v-if="store.snapshot" class="obsisim-strip" data-test="resource-strip">
    <!-- one chip per RESOURCE_IDS entry … -->
    <span class="obsisim-haulers">
      Haulers: <strong data-test="hauler-count">{{ store.haulerCount }}</strong>
      <button data-test="unassign-hauler" :disabled="store.haulerCount === 0"
        @click="engine.dispatch({ type: 'unassignHauler' })">−</button>
      <button data-test="assign-hauler" :disabled="store.snapshot.idleAdults === 0"
        @click="engine.dispatch({ type: 'assignHauler' })">+</button>
      <small v-if="store.snapshot.idleAdults === 0" class="obsisim-reason" data-test="hauler-reason">
        No idle adults — unassign someone first.
      </small>
    </span>
  </div>
</template>
```

The `!` is gone from both reads: inside the guard the narrowing is real rather
than asserted, which is what made the original version wrong.

Re-run: PASS, 4 tests.

- [ ] **Step 4: Write the shell**

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

- [ ] **Step 5: Delete `WorldView` and its test**

```bash
git rm src/app/views/WorldView.vue tests/app/world-view.test.ts
```

Its behaviour is now split across `ui-store` (Task 1), `interaction.ts` (Task 4), `WorldStage` (Task 5) and this shell, and every case it asserted has an equivalent in one of those four test files.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. Failures will be in `src/app/router.ts` and `App.vue`, which still import `WorldView` — Task 12 rewires them, so if the suite cannot even load, do the router edit now and leave the Ledger for Task 12.

- [ ] **Step 7: Commit**

```bash
git add -A src/app tests/app
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
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import InspectorPanel from '../../src/app/components/dock/InspectorPanel.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot, makeWorker } from './fixtures';

/** Mounts the Inspector the way WorldScreen does — through the key — so the
 * remount behaviour under test is the one that actually ships. */
function mountKeyedInspector(snapshot = makeSnapshot()) {
  const engine = { dispatch: vi.fn() };
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  useGameStore(pinia).ingest(snapshot, { paused: true, speed: 1, error: null });
  const ui = useUiStore(pinia);
  const Harness = defineComponent({
    setup: () => () => h(InspectorPanel, {
      key: `${ui.selection.kind}-${'id' in ui.selection ? ui.selection.id : 0}`,
    }),
  });
  const wrapper = mount(Harness, {
    global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } },
  });
  return { wrapper, engine, ui };
}

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

  it('shows a producer\'s recipe, batch, buffers, work power and tools', async () => {
    const producing = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'bakery', workers: 2, workerSlots: 3, state: 'producing', progressPct: 40, buffered: 3, inputBuffered: 5, workPower: 1.75, tooledWorkers: 1 })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, producing);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    const text = wrapper.get('[data-test="inspector"]').text();
    for (const fragment of ['40%', '1.75', 'Flour']) expect(text).toContain(fragment);
    expect(wrapper.get('[data-test="inspector-tools"]').text()).toContain('1');
  });

  it('shows a house\'s beds', async () => {
    const house = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'house', beds: 4, occupants: 2, workerSlots: 0, state: 'housing' })],
      colonists: [makeWorker(9, { homeId: 1 }), makeWorker(10, { homeId: 1 })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, house);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector"]').text()).toContain('2 / 4');
  });

  it('shows a site\'s materials as have over need, not as a bare shortfall', async () => {
    // A sawmill costs 25 wood; 14 outstanding means 11 have arrived. The
    // shortfall alone reads identically at 0/25 and at 24/25.
    const site = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'sawmill', state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 14 } })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, site);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="selection-needs"]').text()).toContain('11 / 25 Wood');
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

  // The POSITIVE case, carried over from the deleted selection-panel.test.ts.
  // Without it, an Inspector that renders TwoStepButton and never wires its
  // confirm to a dispatch passes the cross-building test below — which only
  // proves the FIRST tap does nothing — while failing criterion 1 outright.
  it('demolishes the selected building after the two-step confirm', async () => {
    const { wrapper, engine, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="selection-demolish"]').trigger('click'); // arms
    expect(engine.dispatch).not.toHaveBeenCalled();
    await wrapper.get('[data-test="selection-demolish"]').trigger('click'); // confirms
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 1 });
  });

  // Carried over from tests/app/world-view.test.ts, which Task 6 deletes. The
  // behaviour it guards is a real one and predates this increment: arm
  // Demolish on A, select B, and B must get a disarmed button. Without the
  // key above, TwoStepButton's internal `armed` ref survives the subject
  // change and B is one tap from demolition.
  it('resets an armed demolish when the subject changes — no cross-building confirm', async () => {
    const two = makeSnapshot({ buildings: [makeBuilding(1), makeBuilding(2)] });
    const { wrapper, engine, ui } = mountKeyedInspector(two);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="selection-demolish"]').trigger('click'); // arms
    ui.selectBuilding(2);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="selection-demolish"]').trigger('click'); // must only ARM, not fire
    expect(engine.dispatch).not.toHaveBeenCalled();
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

**First, a new label.** §2.3 promises a site's materials as `have / need`, and
`needsLabel` cannot express that — it renders the outstanding shortfall alone
(`14 Wood`). What a site *has* of a material is its def's cost minus its
remaining need, so add to `src/app/labels.ts`, beside `needsLabel`:

```ts
/**
 * "11 / 25 Wood, 5 / 5 Planks" — what a construction site holds against what it
 * takes, which is the progress `needsLabel`'s shortfall cannot show: "14 Wood"
 * reads the same on a site that has just been ordered as on one load from
 * finishing.
 *
 * `have` is derived, not published: `BuildingSnapshot.constructionNeeds` is the
 * REMAINING need, so cost minus need is what has arrived. Reads the def's cost
 * from BUILDINGS rather than taking it as an argument, the same way
 * `recipeLabel` does, so a cost change cannot desync the two halves.
 */
export function suppliedLabel(defId: BuildingDefId, needs: CostMap): string {
  const cost = BUILDINGS[defId].cost;
  const parts = Object.entries(cost).map(([id, total]) => {
    const outstanding = needs[id as ResourceId] ?? 0;
    return `${total - outstanding} / ${total} ${RESOURCES[id as ResourceId].name}`;
  });
  return parts.length > 0 ? parts.join(', ') : '—';
}
```

Then create `src/app/components/dock/InspectorPanel.vue`, branching first on
`ui.selection.kind`.

**`SelectionPanel` is a starting point, not the contract.** It carries buffers,
storage, the relocation countdown and the construction countdown — and §2.3
promises more than that, none of which exists to be carried across:

| Kind | Fields §2.3 requires | Where they come from |
| --- | --- | --- |
| producer | recipe, batch progress, in-tray, out-tray, work power, tooled workers | `recipeLabel(BUILDINGS[defId])`, `batchLabel`, `inputBuffered`, `buffered`, `workPower.toFixed(2)`, `tooledWorkers` — every one already rendered by `BuildingsView`, so this is relocation, not invention |
| house | beds, and occupants as clickable rows | `batchLabel(beds, occupants, …)`; occupants are `colonists.filter(c => c.homeId === id)` |
| storehouse | `held / capacity` | `waitingLabel(storage, stored, buffered)` |
| site | countdown, and materials as `have / need` | `constructionTicks`, **`suppliedLabel`** — not `needsLabel`, which shows the shortfall alone |

Every label comes from `labels.ts`; nothing here is a second derivation. Then
add:

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

## Task 8: The Colony panel

**Files:**
- Create: `src/app/components/dock/ColonyPanel.vue`
- Test: extend `tests/app/dock-panels.test.ts`

**Interfaces:**
- Consumes: `useGameStore()`.
- Produces: nothing later tasks depend on.

`ResourceStrip` was built in Task 6, because the shell imports it — see the note there.

- [ ] **Step 1: Write the failing test**

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
    ui.selectBuilding(4);
    await wrapper.get('[data-test="colony-row-wood"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'building', id: 4 }); // inert: not even a deselect
    expect(ui.highlight).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: FAIL — cannot resolve `ColonyPanel.vue`.

- [ ] **Step 3: Write the panel**

`ColonyPanel.vue` is `DashboardView.vue`'s existing `<table>` moved into a panel. Its rows carry `data-test="colony-row-<id>"` and **no click handler at all** — inertness is the absence of a handler, and the test above is what stops a later change adding one silently.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/app/dock-panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/dock/ColonyPanel.vue tests/app/dock-panels.test.ts
git commit -m "The resource table becomes a panel, and its rows stay inert"
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
  // No setHighlight([]) here: `select` drops a standing highlight itself, for
  // every caller rather than for this one.
  if (row.subject !== null) {
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
    <!-- `is-overlay` carried over from Step 4 deliberately: this snippet
         REPLACES that element, and dropping the binding here would silently
         undo criterion 7's overlay half — the dock would take its grid column
         back and shrink the canvas in a sidebar-width pane. -->
    <aside v-if="ui.panel" class="obsisim-dock" :class="{ 'is-overlay': ui.narrow }" data-test="dock">
      <!-- Keyed by the subject, exactly as WorldView keyed SelectionPanel by
           `selectedId`. TwoStepButton holds its armed state internally, so an
           unkeyed panel that is merely re-rendered for a new building keeps
           Demolish armed from the old one — and a touch client never blurs the
           button, so the first tap on B dispatches against B. The remount is
           what guarantees a fresh, disarmed confirm. -->
      <InspectorPanel v-if="ui.panel === 'inspector'" :key="`${ui.selection.kind}-${'id' in ui.selection ? ui.selection.id : 0}`" />
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
  it('shows the starving count the Attention panel shows', () => {
    const { wrapper } = mountView(makeSnapshot({
      colonists: [makeWorker(1, { starvingTicks: 40 }), makeWorker(2, { starvingTicks: 12 }), makeWorker(3)],
    }));
    expect(wrapper.get('[data-test="starving"]').text()).toContain('2');
  });

  it('renders a Ledger row without a pre-seeded target, defaulting to the current tile', () => {
    const { wrapper } = mountView(makeSnapshot({ buildings: [makeBuilding(1, { col: 7, row: 3 })] }));
    // Fails against an uninitialised record: the render throws before this.
    expect((wrapper.get('[data-test="move-col-1"]').element as HTMLInputElement).value).toBe('7');
    expect((wrapper.get('[data-test="move-row-1"]').element as HTMLInputElement).value).toBe('3');
  });

  it('seeds a target for a building that appears in a later snapshot', async () => {
    const { wrapper, store } = mountView(makeSnapshot({ tick: 1, buildings: [makeBuilding(1)] }));
    store.ingest(
      makeSnapshot({ tick: 2, buildings: [makeBuilding(1), makeBuilding(2, { col: 9, row: 5 })] }),
      { paused: true, speed: 1, error: null },
    );
    await wrapper.vm.$nextTick();
    expect((wrapper.get('[data-test="move-col-2"]').element as HTMLInputElement).value).toBe('9');
  });

  it('moves a building to typed coordinates', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({ buildings: [makeBuilding(1)] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('9');
    await wrapper.get('[data-test="move-row-1"]').setValue('4');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 9, row: 4 } });
  });

  it('refuses to staff a construction site, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({
      idleAdults: 3,
      buildings: [makeBuilding(1, { workers: 0, workerSlots: 3, state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    }));
    expect(wrapper.get('[data-test="assign-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="assign-reason-1"]').text()).toContain('cannot be staffed');
    await wrapper.get('[data-test="assign-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('explains a no-idle-adults refusal, not only a construction site', async () => {
    const { wrapper } = mountView(makeSnapshot({
      idleAdults: 0,
      buildings: [makeBuilding(1, { workers: 1, workerSlots: 3, state: 'producing' })],
    }));
    expect(wrapper.get('[data-test="assign-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="assign-reason-1"]').text()).toContain('No idle adults');
  });

  it('refuses a move to an occupied tile, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({
      buildings: [makeBuilding(1, { col: 4, row: 1 }), makeBuilding(2, { col: 6, row: 1 })],
    }));
    await wrapper.get('[data-test="move-col-1"]').setValue('6');
    await wrapper.get('[data-test="move-row-1"]').setValue('1'); // building 2's tile
    expect(wrapper.get('[data-test="move-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="move-reason-1"]').text()).toContain('already taken');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('shows the construction countdown and the have/need the Inspector shows', async () => {
    const { wrapper } = mountView(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'sawmill', state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 14 } })],
    }));
    expect(wrapper.get('[data-test="building-ticks-1"]').text()).toBe('20t');
    // §2.5: a renderer failure costs looks, never a number.
    expect(wrapper.get('[data-test="needs-1"]').text()).toContain('11 / 25 Wood');
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

**Audit the Attention panel against the tables before writing anything.** §2.5
promises every number a panel shows is also in a table, and Attention is the
panel most likely to break that, because its rows are derived rather than
copied from an existing view. Walk all eight and confirm each has a home —
this is the whole check, not a sample of it:

| Attention row | Ledger home | Present today? |
| --- | --- | --- |
| *X is full* | `BuildingsView` State (`Output full`) | yes |
| *X has nothing to work with* | `BuildingsView` State (`Waiting for input`) | yes |
| *X has no one working it* | `BuildingsView` State (`Unstaffed`) + Workers | yes |
| *X site needs …* | `BuildingsView` Needs, via `suppliedLabel` | yes, once this task adds it |
| *Bread empties in ~30t* | `DashboardView` Empties in | yes |
| *N colonists have no bed* | `PopulationSummary` Homeless | yes |
| *N adults are idle* | `DashboardView` headline `(N idle)` | yes |
| *N colonists are starving* | — | **no** |

Only the last is missing. `PopulationView` shows each colonist's own starvation
clock and never the count, so a renderer failure would lose a figure the panel
had. Add it to **`PopulationSummary`**, which is already shared by the Dashboard
and the Population view — one edit, both screens, and it sits beside `Homeless`
which is the same shape of number:

```vue
    <span data-test="starving" :class="store.starvingCount > 0 ? 'obsisim-negative' : ''">
      Starving: <strong>{{ store.starvingCount }}</strong>
    </span>
```

`starvingCount` is a store getter, so the panel row and this cell read one
derivation rather than two — the §2.7 rule, and the reason `AttentionRow`'s
message can be built from it too. **Task 2 provides `starvingCount`** on
`game-store.ts` (the `attention` getter's own starving row reads it); this
task only consumes it — do not add a second definition here.

`BuildingsView.vue` gains **a construction countdown column**, **a
site-aware staffing gate**, and two number inputs plus a Move button per row.

The staffing gate is Task 7's fix applied to the other surface. `BuildingsView`
checks only slot capacity and `idleAdults`, so a site — which keeps its def's
`workerSlots` and which `handleAssignWorker` refuses unconditionally — still
shows an enabled `+`. Two surfaces per verb means two gates, or the fallback
becomes the misleading path:

One helper, not three conditions and one message. The reason has to cover every
branch the button disables on — including `idleAdults === 0`, which §2.2 names
as the new case, and which a site-only `v-if` leaves silently disabled:

```ts
// The same three branches, in the same order, as InspectorPanel's
// staffingReason — the two surfaces disable on one rule, so they explain it
// with one wording too. Null means the control is live.
function staffingRefusal(b: BuildingSnapshot): string | null {
  if (b.constructionTicks > 0) return 'A construction site cannot be staffed until it is finished.';
  if (b.workers >= b.workerSlots) return 'Every slot is filled.';
  if (store.snapshot!.idleAdults === 0) return 'No idle adults — unassign someone first.';
  return null;
}
```

```vue
            <button
              :data-test="`assign-${b.id}`"
              :disabled="staffingRefusal(b) !== null"
              @click="engine.dispatch({ type: 'assignWorker', buildingId: b.id })"
            >+</button>
            <small v-if="staffingRefusal(b)" class="obsisim-reason" :data-test="`assign-reason-${b.id}`">
              {{ staffingRefusal(b) }}
            </small>
```

The countdown is a fallback-contract obligation, not decoration: the Inspector
shows `constructionTicks`, and §2.5 promises every number a panel shows is also
in a table. Today's row has State (`Under construction`), Needs (the shortfall)
and Downtime (`relocatingTicks`) — none of which is the countdown, so a renderer
failure would currently lose a figure the panel had. Reuse `downtimeLabel`'s em
dash convention for a settled building:

```vue
          <td :data-test="`building-ticks-${b.id}`">{{ downtimeLabel(b.constructionTicks) }}</td>
```

**And the Needs cell shows the same `have / need` the Inspector does.** Today it
renders `needsLabel` — the outstanding shortfall alone — while Task 7 gives the
panel `suppliedLabel`'s `11 / 25 Wood`. Under §2.5 a renderer failure may cost
the player looks, never a figure, so the supplied and total have to survive into
the table. Same call, same arguments:

```vue
          <td :data-test="`needs-${b.id}`">
            {{ b.constructionTicks > 0 ? suppliedLabel(b.defId, b.constructionNeeds) : '—' }}
          </td>
```

**The targets have to exist before anything binds to them.** `v-model` on
`moveTargets[b.id].col` and `moveRefusal`'s read both dereference an entry the
plan never created: a bare `reactive<Record<number, Tile>>({})` type-checks
perfectly and throws on `.col` at first render, which takes down the Ledger —
the route that exists so a broken renderer is survivable. Seed from the
snapshot, and keep seeding, because buildings appear while the Ledger is open
(a site completes) as well as at mount:

```ts
const moveTargets = reactive<Record<number, { col: number; row: number }>>({});

// Defaulted to the building's CURRENT tile, which is both a valid value and
// the useful one: the fields show where it is before you change them, so a
// mistyped move is a visible edit rather than a jump from (0, 0).
//
// `immediate` covers the first render; re-running on every snapshot covers
// buildings that arrive later. Existing entries are never overwritten — that
// would wipe what the player is halfway through typing, twice a second.
watch(
  () => store.snapshot?.buildings,
  (buildings) => {
    for (const b of buildings ?? []) {
      if (moveTargets[b.id] === undefined) moveTargets[b.id] = { col: b.col, row: b.row };
    }
  },
  { immediate: true },
);
```

Entries for demolished buildings are left behind deliberately: nothing renders
them, and pruning invites the id-reuse bug a colony reset already causes
elsewhere (`renderer.ts` recycles entity ids from 1).

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

**And it gates on the same rule the canvas does.** `handleMoveBuilding` refuses
an occupied tile, the camp band, a fractional value and anything outside
`snapshot.map`, all through `isTileBuildable` — the identical predicate the
world screen's ghost already uses to paint a tile red. `min="0"` on an input
constrains the spinner, not the click handler, so without this the Ledger offers
a Move that is certain to be rejected, which is exactly what §2.2 forbids:

```ts
// The shared predicate, not a second derivation of it — the same reason
// WorldView's tileValid calls it rather than re-checking bounds by hand.
function moveRefusal(b: BuildingSnapshot): string | null {
  if (b.constructionTicks > 0) return 'A building under construction cannot be moved.';
  const { col, row } = moveTargets[b.id];
  if (!Number.isInteger(col) || !Number.isInteger(row)) return 'Whole tiles only.';
  if (!isTileBuildable(store.snapshot!.map, store.snapshot!.buildings, col, row)) {
    return 'That tile is off the map, in the camp band, or already taken.';
  }
  return null;
}
```

`:disabled="moveRefusal(b) !== null"`, with the reason rendered beside it as
`data-test="move-reason-<id>"` — stated in the row, not in a `title`.


```vue
          <td>
            <input :data-test="`move-col-${b.id}`" v-model.number="moveTargets[b.id].col" type="number" min="0" />
            <input :data-test="`move-row-${b.id}`" v-model.number="moveTargets[b.id].row" type="number" min="0" />
            <!-- Deliberately worse than dragging a ghost across a map: this
                 exists so the fallback is complete (spec §2.2), not so it is
                 nice. Gated on moveRefusal below — which covers the site case
                 AND every coordinate the engine would reject — with the reason
                 rendered in the row rather than hidden in a title. -->
            <button :data-test="`move-${b.id}`" :disabled="moveRefusal(b) !== null"
              @click="moveTo(b.id)">Move</button>
            <small v-if="moveRefusal(b)" class="obsisim-reason" :data-test="`move-reason-${b.id}`">
              {{ moveRefusal(b) }}
            </small>
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

- [ ] **Step 6: Prove criterion 5 against the real router**

Neither existing lifecycle test reaches this. Task 5's toggles `WorldStage` in a
hand-built `KeepAlive`, and Task 6's panel tour never navigates — so a wrong
`include` name in `App.vue` (it must now match `defineOptions({ name:
'WorldScreen' })`, not the deleted `WorldView`) or a misplaced `<keep-alive>`
would rebuild the WebGL context on every real Ledger visit while every other
test passes. That rename is exactly the mistake this catches.

Add to `tests/app/ledger-view.test.ts`:

```ts
  it('builds the renderer exactly once across the panels AND the ledger round trip', async () => {
    const { renderer, factory } = makeFake();
    const { router } = await mountApp(factory);
    const ui = useUiStore();
    for (const panel of ['colony', 'population', 'economy', 'attention', 'inspector'] as const) {
      ui.openPanel(panel);
      await nextTick();
    }
    await router.push('/ledger');
    await router.push('/');
    await flushPromises();
    expect(factory).toHaveBeenCalledOnce();
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(renderer.stop).toHaveBeenCalled();   // deactivated on the way out
    expect(renderer.start).toHaveBeenCalled();  // reactivated on the way back
  });
```

- [ ] **Step 7: Commit**

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

**A glob threshold is an aggregate, and the PBI is called *Per-View* Coverage
Floors.** By default Vitest checks these numbers against the combined coverage
of every file the glob matches, so a well-covered `TopBar` and `NoticeBanner`
can carry a brand-new panel with almost no tests over the line — the floor would
be green while the thing it was added to protect is uncovered. Step 2's "if a
view is short, add the missing case" is unenforceable in that mode, because
nothing reports which view is short.

Enable per-file checking. **Verify the option against the installed Vitest
before writing it** — `node_modules/vitest`'s types are the authority, not this
plan — and take whichever branch is true:

- If `perFile` is accepted inside a glob entry, set it on these two entries
  alone. Preferred: it leaves the engine and shared floors exactly as they are.
- If `perFile` is only a top-level `thresholds` option, it applies to every
  glob including `src/engine/**` and `src/shared/**` at 90/85/90/90. Run
  `npm run test:coverage` before committing: those are aggregates today, so a
  single thin engine file can newly fail. If one does, that is a real gap and
  worth a test — but it is **not** this increment's gap, and if it cannot be
  closed cheaply, record the number and leave per-file off for the engine globs
  rather than lowering a floor to fit.

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
