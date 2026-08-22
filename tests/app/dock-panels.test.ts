// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import InspectorPanel from '../../src/app/components/dock/InspectorPanel.vue';
import ColonyPanel from '../../src/app/components/dock/ColonyPanel.vue';
import PopulationPanel from '../../src/app/components/dock/PopulationPanel.vue';
import EconomyPanel from '../../src/app/components/dock/EconomyPanel.vue';
import AttentionPanel from '../../src/app/components/dock/AttentionPanel.vue';
import { NOMAD_REJECTIONS } from '../../src/shared/population';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot, makeWorker, stockedWith } from './fixtures';

/** Mounts the Inspector the way WorldScreen does — through the key — so the
 * remount behaviour under test is the one that actually ships. Restates
 * `WorldScreen.vue`'s own `inspectorKey` computed rather than importing it,
 * because importing the view here would drag in BuildPalette/WorldStage/
 * WorldLegend for a test that only wants the key expression; see that
 * computed's own comment, which names this file back. */
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

function mountPanel(component: typeof InspectorPanel, snapshot = makeSnapshot()) {
  const engine = { dispatch: vi.fn() };
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  useGameStore(pinia).ingest(snapshot, { paused: true, speed: 1, error: null });
  const wrapper = mount(component, {
    global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } },
  });
  return { wrapper, engine, ui: useUiStore(pinia) };
}

describe('InspectorPanel', () => {
  const staffable = makeSnapshot({
    idleAdults: 2,
    buildings: [makeBuilding(1, { defId: 'farm', workers: 1, workerSlots: 3, state: 'producing' })],
  });

  // deletion-inventory.md Section B, case 1: name, tile, staffing and state
  // label all in the header, none of it invented — the same fields
  // SelectionPanel showed, read off the same snapshot fixture.
  it('shows the selected building: name, tile, staffing, state label', async () => {
    const { wrapper, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    const text = wrapper.get('[data-test="inspector"]').text();
    expect(text).toContain('Farm');
    expect(text).toContain('(4, 1)'); // makeBuilding(1)'s default tile
    expect(text).toContain('1 / 3'); // workers / workerSlots
    expect(text).toContain('Producing');
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

  // Fix round 1, Finding 1 (Important): `staffingReason`'s middle branch
  // (`b.workers >= b.workerSlots`, "Every slot is filled.") had a helper
  // branch nobody exercised — only branch 1 (construction site) and branch 3
  // (no idle adults) had tests. `constructionTicks: 0` (default) rules out
  // branch 1, and `idleAdults: 2` (not 0) rules out branch 3 firing instead —
  // with `idleAdults: 0` this test would pass for the wrong reason and prove
  // nothing about branch 2, which is exactly what the review flagged.
  it('disables assign when every slot is filled and says why', async () => {
    const full = makeSnapshot({
      idleAdults: 2,
      buildings: [makeBuilding(1, { workers: 3, workerSlots: 3, state: 'producing' })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, full);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector-assign"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="inspector-staffing-reason"]').text()).toContain('Every slot is filled.');
  });

  // Fix round 1, Finding 1's "while you are there" check: unlike assign,
  // unassign's disabled-at-zero-workers case had a `:disabled` binding but no
  // stated reason anywhere in the panel — spec §2.2's rule applies to both
  // staffing directions, not just assign. Added `unassignReason` alongside
  // `staffingReason` (same convention) and this test to cover it.
  it('disables unassign with no workers staffed and says why', async () => {
    const empty = makeSnapshot({ buildings: [makeBuilding(1, { workers: 0, workerSlots: 3 })] });
    const { wrapper, ui } = mountPanel(InspectorPanel, empty);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="inspector-unassign"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="inspector-unassign-reason"]').text()).toContain('unassign');
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

  // deletion-inventory.md Section B, case 7: a storehouse's `held / capacity`
  // is the storage > 0 gate's positive half; the producer fixture below is
  // its negative half — nothing here to show, so nothing renders.
  it('shows a storehouse\'s contents against capacity, and hides it for a producer', async () => {
    const storehouse = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'storehouse', workerSlots: 0, state: 'storing', stored: 41, storage: 60 })],
    });
    const { wrapper: storeWrapper, ui: storeUi } = mountPanel(InspectorPanel, storehouse);
    storeUi.selectBuilding(1);
    await storeWrapper.vm.$nextTick();
    expect(storeWrapper.get('[data-test="inspector-storage"]').text()).toContain('41 / 60');

    const { wrapper: producerWrapper, ui: producerUi } = mountPanel(InspectorPanel, staffable);
    producerUi.selectBuilding(1);
    await producerWrapper.vm.$nextTick();
    expect(producerWrapper.find('[data-test="inspector-storage"]').exists()).toBe(false);
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

  // deletion-inventory.md Section B, case 11: the negative half of case 10 —
  // a settled building shows no construction lines at all, or "disabled for
  // a site" would be indistinguishable from "always present".
  it('shows no construction lines for a settled building', async () => {
    const { wrapper, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-construction"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="selection-needs"]').exists()).toBe(false);
  });

  // deletion-inventory.md Section B, cases 8/9: a relocating building's
  // countdown, and its negative half — nothing shown once it has settled.
  it('shows the remaining downtime for a relocating building, and hides it once settled', async () => {
    const relocating = makeSnapshot({
      buildings: [makeBuilding(1, { state: 'relocating', relocatingTicks: 9 })],
    });
    const { wrapper, ui } = mountPanel(InspectorPanel, relocating);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="selection-relocating"]').text()).toContain('9t');

    const { wrapper: settledWrapper, ui: settledUi } = mountPanel(InspectorPanel, staffable);
    settledUi.selectBuilding(1);
    await settledWrapper.vm.$nextTick();
    expect(settledWrapper.find('[data-test="selection-relocating"]').exists()).toBe(false);
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

  // deletion-inventory.md Section B, case 13: the positive half of 12 — a
  // settled building's Move is NOT disabled, or the site-only refusal above
  // would be indistinguishable from a control disabled unconditionally. Also
  // exercises the "arms move mode rather than dispatching" behaviour on the
  // same click.
  it('arms move mode rather than dispatching immediately', async () => {
    const { wrapper, engine, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    const move = wrapper.get('[data-test="inspector-move"]');
    expect(move.attributes('disabled')).toBeUndefined();
    await move.trigger('click');
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

  // deletion-inventory.md Section B, case 3's negative half: a double-click's
  // second event carries MouseEvent.detail > 1, which TwoStepButton refuses to
  // treat as a confirm — a wandering double-click must not skip the arm step.
  it('does not demolish on a double-click', async () => {
    const { wrapper, engine, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    const demolish = wrapper.get('[data-test="selection-demolish"]');
    await demolish.trigger('click', { detail: 2 });
    expect(engine.dispatch).not.toHaveBeenCalled();
    expect(demolish.text()).not.toContain('Confirm');
  });

  // deletion-inventory.md Section B, case 4: the building can leave the
  // snapshot out from under an unchanged selection (e.g. another surface
  // demolished it) — the Inspector must stop rendering it reactively, not
  // merely fail to have shown it in the first place.
  it('renders nothing once the selected building has left the snapshot', async () => {
    const { wrapper, ui } = mountPanel(InspectorPanel, staffable);
    ui.selectBuilding(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="inspector"]').exists()).toBe(true);
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="inspector"]').exists()).toBe(false);
  });

  // Carried over from tests/app/world-view.test.ts, which Task 6 deletes. The
  // behaviour it guards is a real one and predates this increment: arm
  // Demolish on A, select B, and B must get a disarmed button. Without the
  // key above, TwoStepButton's internal `armed` ref survives the subject
  // change and B is one tap from demolition. This is deletion-inventory.md's
  // A22, and WorldScreen.vue's `inspectorKey` computed is the render site the
  // `mountKeyedInspector` helper above restates.
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

  // Fix round 1, Finding 2 (Important): the test above only covers building
  // 1 -> building 2 — a regression that simplified `inspectorKey` to a bare
  // `${id}` (dropping the `kind` prefix) would pass every test in this file,
  // because nothing gives a building and a colonist the SAME numeric id. This
  // fixture does: building 3 and colonist 3.
  //
  // A TwoStepButton-armed assertion (arm Demolish on building 3, select
  // colonist 3, select building 3 again, expect the button disarmed) is NOT
  // used here even though the brief suggests it as a fallback: hand-verified
  // against the buggy bare-`${id}` key, that assertion still PASSES, because
  // `InspectorPanel`'s own template already toggles a `v-if`/`v-else-if`
  // between the building card and `InspectorColonist` on every selection-kind
  // change (`building`/`colonist` are mutually exclusive computeds) — that
  // inner branch switch tears down TwoStepButton regardless of whether the
  // OUTER `InspectorPanel` instance was ever recreated. So it proves nothing
  // about the key specifically; it would pass with the bug present.
  //
  // What the `kind` prefix actually controls is whether Vue reuses the SAME
  // `InspectorPanel` component instance across the selection change or
  // creates a fresh one — an outer-instance-identity fact, not anything
  // currently rendered. `findComponent(...).vm.$.uid` (both `@vue/test-utils`
  // and Vue's own internal instance handle) is what actually distinguishes
  // a remount from Vue quietly reusing the instance — confirmed by the
  // mutation check below, which this assertion does fail.
  it('remounts across a building/colonist id collision, not just building-to-building', async () => {
    const collision = makeSnapshot({ buildings: [makeBuilding(3)], colonists: [makeWorker(3)] });
    const { wrapper, ui } = mountKeyedInspector(collision);
    ui.selectBuilding(3);
    await wrapper.vm.$nextTick();
    const before = (wrapper.findComponent(InspectorPanel).vm as unknown as { $: { uid: number } }).$.uid;
    ui.selectColonist(3);
    await wrapper.vm.$nextTick();
    ui.selectBuilding(3);
    await wrapper.vm.$nextTick();
    const after = (wrapper.findComponent(InspectorPanel).vm as unknown as { $: { uid: number } }).$.uid;
    expect(after).not.toBe(before);
  });

  it('renders nothing when nothing is selected', () => {
    const { wrapper } = mountPanel(InspectorPanel, staffable);
    expect(wrapper.find('[data-test="inspector"]').exists()).toBe(false);
  });
});

describe('ColonyPanel', () => {
  it('lists every resource with its runway', () => {
    const { wrapper } = mountPanel(ColonyPanel, makeSnapshot({ stockpile: stockedWith({ wood: 42 }) }));
    expect(wrapper.get('[data-test="colony-row-wood"]').text()).toContain('42');
  });

  // Spec §2.3's inert row (a resource has no subject on the map): the
  // absence of a click handler IS the behaviour, so this asserts the
  // standing selection survives the click untouched — not even a deselect,
  // which a stray `@click="ui.select(...)"` added later would still trip.
  it('does not select anything when a resource row is clicked', async () => {
    const { wrapper, ui } = mountPanel(ColonyPanel, makeSnapshot({ stockpile: stockedWith({ wood: 42 }) }));
    ui.selectBuilding(4);
    await wrapper.get('[data-test="colony-row-wood"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'building', id: 4 }); // inert: not even a deselect
    expect(ui.highlight).toEqual([]);
  });
});

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

  // Fix round 1 (this task's own brief, reviewed before it was ever run): the
  // brief's own draft test only checked `Object.values(NOMAD_REJECTIONS)).
  // toContain(...)` — membership in the Record's five sentences, which a
  // panel wired to the WRONG branch (noBed's sentence shown over a hungry-
  // but-bedded colony, say) would still have passed. Pinned to the specific
  // sentence instead, the way Task 7 pinned InspectorPanel's three staffing
  // branches after finding the identical gap there.
  //
  // 2 free beds (`beds.total: 4` minus `population: 2`) rules out `noBed`;
  // the default zeroed stockpile (no `stockpile` override) is what reaches
  // `notEnoughFood` — `nomadBlocker` checks beds before food, so a fixture
  // with both gates shut would prove nothing about which sentence this is.
  it('names the food gate when there is a bed but no food', () => {
    const hungry = makeSnapshot({ population: 2, beds: { total: 4, occupied: 2 }, colonists: [makeWorker(1)] });
    const { wrapper } = mountPanel(PopulationPanel, hungry);
    expect(wrapper.get('[data-test="recruit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="recruit-reason"]').text()).toBe(NOMAD_REJECTIONS.notEnoughFood);
  });

  // The other branch a different fixture reaches: every bed already claimed
  // (`beds.total === population`, so `spareBedsIn` is 0) even though the
  // store is stocked with far more than `nomadFoodPerHead` needs.
  // `nomadBlocker` checks `freeBeds <= 0` FIRST, ahead of food, so this is the
  // only fixture shape that can tell noBed's sentence apart from
  // notEnoughFood's — a colony well fed AND full of beds would never reach
  // this branch at all.
  it('names the bed gate when every bed is claimed, even with food to spare', () => {
    const noBeds = makeSnapshot({
      population: 2, beds: { total: 2, occupied: 2 },
      colonists: [makeWorker(1), makeWorker(2)],
      stockpile: stockedWith({ bread: 400 }),
    });
    const { wrapper } = mountPanel(PopulationPanel, noBeds);
    expect(wrapper.get('[data-test="recruit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="recruit-reason"]').text()).toBe(NOMAD_REJECTIONS.noBed);
  });

  // Spec §2.3: a Population colonist row selects that colonist. Asserted on
  // `ui.selection` only — the store half of the chain. The OTHER half (that
  // `ui.selectColonist` actually reaches `renderer.setSelection`) is
  // WorldStage.vue's own watcher, already covered by
  // `tests/app/world-stage.test.ts`'s "forwards the store selection to the
  // renderer" — this file must never import `src/app/world/renderer.ts`, so
  // that assertion cannot live here too. See task-9-report.md for the
  // end-to-end check that watcher is still wired.
  it('selects a colonist when their row is clicked', async () => {
    const { wrapper, ui } = mountPanel(PopulationPanel, peopled);
    await wrapper.get('[data-test="colonist-row-2"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'colonist', id: 2 });
  });
});

describe('EconomyPanel', () => {
  // Spec §2.3: "Economy stage row -> highlights every building of that def;
  // selects nothing". A stage is a def (CHAINS' `farm` step), not a
  // building, so its click result names however many buildings exist for
  // that def — the plural case, exercised here with two farms. `ui.select`
  // only clears `highlight` on a NON-none outgoing selection (see
  // ui-store.ts's own comment), which is what lets `clearSelection()` then
  // `setHighlight(...)` land both halves rather than the second one erasing
  // the first.
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

  // The one-member case, which spec §2.3 calls out by name: a rule that
  // selected a single-instance stage and highlighted a multi-instance one
  // would behave differently on the same click depending on a count the
  // player is not looking at. This asserts the click still highlights (a
  // one-element array), never `ui.select({ kind: 'building', id: 1 })`.
  it('highlights a single-instance stage too, rather than selecting it', async () => {
    const one = makeSnapshot({ buildings: [makeBuilding(1, { defId: 'farm' })] });
    const { wrapper, ui } = mountPanel(EconomyPanel, one);
    await wrapper.get('[data-test="stage-row-farm"]').trigger('click');
    expect(ui.highlight).toEqual([{ kind: 'building', id: 1 }]);
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  // The empty case: a def with no buildings still renders a "not built" row
  // (chainTableRows renders one row per CHAINS step regardless of whether
  // any building exists), and clicking it highlights the empty set rather
  // than erroring or highlighting some other def's buildings.
  it('highlights nothing for a stage with no buildings', async () => {
    const { wrapper, ui } = mountPanel(EconomyPanel, makeSnapshot({ buildings: [] }));
    await wrapper.get('[data-test="stage-row-farm"]').trigger('click');
    expect(ui.highlight).toEqual([]);
  });
});

describe('AttentionPanel', () => {
  // Spec §2.3's single-building row selects its subject — but the tension
  // this task exists to resolve is WHICH panel is open afterwards. §2.1
  // scopes the auto-open rule to the canvas ("Selecting a building ON THE
  // CANVAS auto-opens the Inspector"); §2.3 states the Attention case in
  // different words on purpose — "the bakery is selected WITH THE INSPECTOR
  // ONE CLICK AWAY", not "and the Inspector opens". A plain `ui.select()`
  // would fail this test: it forces `panel = 'inspector'` unconditionally
  // (ui-store.ts), which would swap this worklist out from under the player
  // on every single row instead of leaving them free to work through it.
  // `ui.panel` is set to `'attention'` before the click (mounting the panel
  // in isolation does not imply the dock is showing it) precisely so a
  // regression to plain `ui.select()` has something to disagree with.
  it('selects the building a row names, without switching the dock away from Attention', async () => {
    const stalled = makeSnapshot({ buildings: [makeBuilding(4, { defId: 'sawmill', state: 'outputFull' })] });
    const { wrapper, ui } = mountPanel(AttentionPanel, stalled);
    ui.openPanel('attention');
    await wrapper.get('[data-test="attention-full-4"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'building', id: 4 });
    expect(ui.panel).toBe('attention'); // the tension this task resolves — see comment above
  });

  // Spec §2.3's plural row: "highlights that set; selects nothing". The
  // dock keeps a selection alive across a panel switch (§2.1), so a
  // standing selection from an earlier Inspector visit would otherwise
  // survive this click untouched — the building stays selected while the
  // pulse names colonists instead, a state the player never asked for.
  it('clears a standing selection when a plural row is clicked', async () => {
    const homeless = makeSnapshot({ homeless: 1, buildings: [makeBuilding(4)], colonists: [makeWorker(2)] });
    const { wrapper, ui } = mountPanel(AttentionPanel, homeless);
    ui.selectBuilding(4); // the dock keeps this across a panel switch — hence the risk
    await wrapper.get('[data-test="attention-homeless"]').trigger('click');
    expect(ui.selection).toEqual({ kind: 'none' });
    expect(ui.highlight).toEqual([{ kind: 'colonist', id: 2 }]);
  });

  // Spec §2.3's inert row, and the case that tells "inert" apart from
  // "clears": a runway warning names no building, so it must not deselect
  // the sawmill the player is looking at — a bare `ui.clearSelection()` with
  // no highlight guard would pass the plural test above while failing this
  // one.
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

  // The inert row's affordance, not just its behaviour: this panel's rows
  // share one click handler that branches on the row (unlike ColonyPanel/
  // EconomyPanel's inert rows, which carry no handler at all — see
  // AttentionPanel.vue's own comment for why that pattern does not fit a
  // heterogeneous, data-driven list), so nothing here would otherwise stop
  // the runway row from looking exactly as clickable as the sawmill row
  // beside it.
  it('marks the inert runway row so it does not look clickable either', () => {
    const draining = makeSnapshot({
      stockpile: { ...stockedWith({ bread: 20 }), bread: { stock: 20, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    });
    const { wrapper } = mountPanel(AttentionPanel, draining);
    expect(wrapper.get('[data-test="attention-runway-bread"]').classes()).toContain('is-inert');
  });

  it('says so when nothing needs attention', () => {
    const fine = makeSnapshot({ buildings: [makeBuilding(1, { workers: 2, workerSlots: 2, state: 'producing' })] });
    const { wrapper } = mountPanel(AttentionPanel, fine);
    expect(wrapper.get('[data-test="attention-empty"]').text()).toContain('Nothing needs attention');
  });
});
