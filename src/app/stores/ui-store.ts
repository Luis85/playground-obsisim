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

/** The slice of UI-store state `commitSelection` below reads and writes.
 * Typed structurally, as a plain function parameter, rather than against the
 * store instance `defineStore` returns — that type does not exist yet at
 * this point in the file, and referencing it here would make the function
 * depend on the very store it is a helper for. */
interface SelectionState {
  mode: Mode;
  selection: Selection;
  highlight: Selection[];
}

/**
 * The state transition `select` and `selectKeepingPanel` share: cancel an
 * armed move the new subject does not belong to (spec §2.1's invariant),
 * cancel an armed place, commit the selection, and — on a non-`none`
 * outgoing value — drop a standing highlight (§2.3: a selection and a
 * highlight are alternatives, never both; see `select`'s own comment for why
 * that clearing is enforced here rather than by each caller).
 *
 * A free function, not a third store action, and returning a bare boolean
 * rather than being folded into `select` as an options parameter: see
 * `selectKeepingPanel`'s own comment for why splitting it out this way,
 * rather than branching on a flag inside one bigger method, is what keeps
 * both callers under fallow's complexity gate.
 */
function commitSelection(state: SelectionState, next: Selection): boolean {
  const armedMove = movedBuilding(state.mode);
  const stillArmed = armedMove !== null && next.kind === 'building' && next.id === armedMove;
  if (armedMove !== null && !stillArmed) state.mode = { kind: 'idle' };
  if (state.mode.kind === 'place' && next.kind !== 'none') state.mode = { kind: 'idle' };
  state.selection = next;
  if (next.kind === 'none') return false;
  state.highlight = [];
  return true;
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
      if (commitSelection(this, next)) this.panel = 'inspector';
    },
    selectBuilding(id: number) { this.select({ kind: 'building', id }); },
    selectColonist(id: number) { this.select({ kind: 'colonist', id }); },
    clearSelection() { this.select({ kind: 'none' }); },
    /**
     * `select` above, minus the one line that opens the Inspector.
     *
     * §2.1 states the auto-open rule scoped to a single route — "Selecting a
     * building **on the canvas** auto-opens the Inspector" — and §2.3
     * deliberately does not repeat that promise for a panel row: its own
     * wording is "the bakery is selected **with the Inspector one click
     * away**", not "and the Inspector opens". Attention is a list of
     * problems to work through; a click that swapped the list for the
     * Inspector on every row would force a trip back to Attention after
     * each one. So this is a second action, not a flag on `select`: folding
     * it into `select` as an options object pushed that method's own
     * cyclomatic complexity past fallow's CRAP gate (an estimated-coverage
     * function is penalised quadratically in branch count — see
     * check-quality.mjs's own header), and `commitSelection` below is the
     * fix, not a suppression — the shared state transition lives in one
     * function both callers reduce to, so neither one's complexity has to
     * absorb the other's decision.
     *
     * `AttentionPanel`'s single-subject row is the one caller: every other
     * selection in the app — the canvas (`selectBuilding`/`selectColonist`,
     * via `useWorldInteraction.clickPick`) and Population's colonist row —
     * goes through `select` above and keeps opening the Inspector exactly as
     * it does today. See `ui-store.test.ts`'s "auto-opens the inspector..."
     * case (still `select`) and `dock-panels.test.ts`'s Attention tests
     * (this method), which pin both halves so neither regresses into the
     * other.
     */
    selectKeepingPanel(next: Selection) {
      commitSelection(this, next);
    },

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
