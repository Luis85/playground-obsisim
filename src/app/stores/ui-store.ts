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
