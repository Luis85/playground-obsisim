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
