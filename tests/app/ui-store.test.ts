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
    // Deleting `this.panel = null` from closeDock would fail neither
    // assertion in this test file without this line.
    expect(ui.panel).toBe(null);
  });

  it('re-selecting the SAME building does not cancel its own armed move', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.selectBuilding(7);
    expect(ui.mode).toEqual({ kind: 'move', buildingId: 7 });
  });

  // openPanel only idles an armed move when `panel !== this.panel`. Reopening
  // the panel that is already open (e.g. the Inspector the selection itself
  // opened) has not dismissed anything, so the move must survive.
  it('re-opening the SAME panel does not cancel an armed move', () => {
    const ui = useUiStore();
    ui.selectBuilding(7);
    ui.armMove(7);
    ui.openPanel('inspector'); // already the open panel
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

  // The rule is on `next.kind !== 'none'`, not `next.kind === 'building'`. A
  // Population row selecting a colonist is a real route out of an armed
  // palette, and an implementation gated on 'building' would pass every other
  // test here while missing this one.
  it('selecting a colonist cancels an armed place, and the selection stands', () => {
    const ui = useUiStore();
    ui.armPlace('farm');
    ui.selectColonist(3);
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'colonist', id: 3 });
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

  it('cancelMode idles an armed mode directly', () => {
    const ui = useUiStore();
    ui.armPlace('farm');
    ui.cancelMode();
    expect(ui.mode).toEqual({ kind: 'idle' });
  });

  it('setNarrow records the overlay layout flag from WorldScreen\'s ResizeObserver', () => {
    const ui = useUiStore();
    expect(ui.narrow).toBe(false);
    ui.setNarrow(true);
    expect(ui.narrow).toBe(true);
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
