// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import PopulationView from '../../src/app/views/PopulationView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { BALANCE } from '../../src/engine/content/balance';
import { makeSnapshot, makeWorker } from './fixtures';
import type { ColonistSnapshot, Snapshot } from '../../src/shared/snapshot';

// A single idle worker, overridable field by field — hunger is the only
// field this file's cases vary, but the full shape keeps callers honest
// about what a ColonistSnapshot actually carries.
function worker(overrides: Partial<ColonistSnapshot> = {}): ColonistSnapshot {
  return makeWorker(1, overrides);
}

// Mounts with a fresh testing Pinia each call, so tests never leak state
// between it.each cases the way a shared module-level store would. Takes a
// whole Snapshot override rather than just a roster: the headline reads
// demographics, beds and mealsPerHead, none of which this fixture derives
// from `colonists`.
function mountPopulationView(overrides: Partial<Snapshot>) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(PopulationView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  const store = useGameStore();
  store.ingest(makeSnapshot(overrides), { paused: true, speed: 1, error: null });
  return { engine, wrapper, store };
}

/**
 * Six colonists whose every displayed number is DISTINCT, so a cell bound to
 * the wrong row or the wrong stage renders a different string rather than
 * coincidentally the right one.
 *
 * Ages are 4/25/30/34/58/60 years, stage counts are 1 child / 3 adults / 2
 * elders (mutually distinct — a headline cell reading elders where it means
 * children would show 2, not 1), and beds 5-of-9 collides with none of them.
 * Every aggregate agrees with the roster it summarises: colonist 3 is the one
 * homeless row, so `homeless` is 1 and `occupied` is the other 5.
 */
const ROSTER: Partial<Snapshot> = {
  colonists: [
    makeWorker(1, { ageTicks: 400, stage: 'child', homeId: 9, commuteTiles: 1, commuteFactor: 1 }),
    makeWorker(2, { ageTicks: 2500, stage: 'adult', homeId: 9, commuteTiles: 12, commuteFactor: 0.7 }),
    makeWorker(3, { ageTicks: 3000, stage: 'adult', homeId: null, commuteTiles: 0, commuteFactor: BALANCE.homelessFactor, starvingTicks: 37 }),
    makeWorker(4, { ageTicks: 3400, stage: 'adult', homeId: 9, commuteTiles: 3, commuteFactor: 0.97 }),
    makeWorker(5, { ageTicks: 5800, stage: 'elder', homeId: 10, commuteTiles: 2, commuteFactor: 1 }),
    makeWorker(6, { ageTicks: 6000, stage: 'elder', homeId: 10, commuteTiles: 0, commuteFactor: 1 }),
  ],
  population: 6,
  demographics: { children: 1, adults: 3, elders: 2 },
  beds: { total: 9, occupied: 5 },
  homeless: 1,
  mealsPerHead: 4.5,
};

describe('PopulationView', () => {
  // Keyed off BALANCE, not literals, so a balance retune can't silently
  // invalidate this test: views carry no coverage floor, so this is the only
  // gate that would catch a dropped binding or a flipped comparison.
  it.each([
    [0, ''],
    [BALANCE.mealThreshold, 'obsisim-warning'],
    [BALANCE.hungerMax, 'obsisim-negative'],
  ])('hunger %i renders with class %o', async (hunger, expected) => {
    const { wrapper } = mountPopulationView({ colonists: [worker({ hunger })] });
    await wrapper.vm.$nextTick();
    const cell = wrapper.get('[data-test="hunger-1"]');
    expect(cell.classes()).toEqual(expected === '' ? [] : [expected]);
  });

  // A hauler's own buildingId is null, same as a truly idle worker's — jobLabel
  // must tell them apart via `hauling`, not just render "Idle" for both. Two
  // rows in one mount (rather than two mounts) so the assertion also pins the
  // row ordering matching worker array order, not just the label text.
  it('labels a hauling worker "Hauling" and leaves an idle one "Idle"', async () => {
    const { wrapper } = mountPopulationView({
      colonists: [makeWorker(1, { hauling: true }), makeWorker(2, {})],
    });
    await wrapper.vm.$nextTick();
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0].text()).toContain('Hauling');
    expect(rows[1].text()).toContain('Idle');
  });

  // Every age in the roster is a different number of years, so a cell reading
  // the wrong ROW is as visible as a cell doing the wrong arithmetic. The
  // expected strings divide by BALANCE.yearTicks rather than hardcoding "25y",
  // which is the one place the tick->year conversion is declared.
  it('renders each colonist\'s age in years, from that colonist\'s own ageTicks', async () => {
    const { wrapper } = mountPopulationView(ROSTER);
    await wrapper.vm.$nextTick();
    for (const c of ROSTER.colonists!) {
      expect(wrapper.get(`[data-test="age-${c.id}"]`).text()).toBe(`${Math.floor(c.ageTicks / BALANCE.yearTicks)}y`);
    }
    expect(wrapper.get('[data-test="age-2"]').text()).toBe('25y'); // 2500 ticks, spelled out once
  });

  it('names each life stage in words rather than leaking the raw union', async () => {
    const { wrapper } = mountPopulationView(ROSTER);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="stage-1"]').text()).toBe('Child');
    expect(wrapper.get('[data-test="stage-2"]').text()).toBe('Adult');
    expect(wrapper.get('[data-test="stage-5"]').text()).toBe('Elder');
    expect(wrapper.text()).not.toContain('elder'); // the raw stage, not the label
  });

  // The commute is the number the player can act on by moving a house, so the
  // cell must carry the house, the distance AND the work-power share — not just
  // one of the three. Homelessness replaces all of it and is flagged.
  it('states each colonist\'s home, distance and commute cost, and flags the homeless one', async () => {
    const { wrapper } = mountPopulationView(ROSTER);
    await wrapper.vm.$nextTick();
    const housed = wrapper.get('[data-test="commute-2"]');
    expect(housed.text()).toContain('#9');       // which house, so it can be found
    expect(housed.text()).toContain('12.0');     // how far, so the move is measurable
    expect(housed.text()).toContain('70%');      // what it costs
    expect(housed.classes()).not.toContain('obsisim-warning');
    // A different row's different distance, so the cell above is not a constant.
    expect(wrapper.get('[data-test="commute-5"]').text()).toContain('#10');
    expect(wrapper.get('[data-test="commute-5"]').text()).toContain('100%');

    const homeless = wrapper.get('[data-test="commute-3"]');
    expect(homeless.text()).toBe('Homeless');
    expect(homeless.classes()).toContain('obsisim-warning');
  });

  it('flags a starving colonist with a countdown, and leaves the others alone', async () => {
    const { wrapper } = mountPopulationView(ROSTER);
    await wrapper.vm.$nextTick();
    const dying = wrapper.get('[data-test="starving-3"]');
    expect(dying.text()).toBe(`${BALANCE.starvationDeathTicks - 37}t`);
    expect(dying.classes()).toContain('obsisim-negative');
    const fine = wrapper.get('[data-test="starving-2"]');
    expect(fine.text()).toBe('—');
    expect(fine.classes()).not.toContain('obsisim-negative');
  });

  // The countdown must fall as the clock runs, not merely be non-empty: a cell
  // rendering `starvingTicks` itself (rather than the ticks LEFT) would pass
  // every single-snapshot assertion above while counting the wrong way.
  it('the starvation countdown shrinks as the snapshot\'s clock advances', async () => {
    const { wrapper, store } = mountPopulationView(ROSTER);
    await wrapper.vm.$nextTick();
    const at = async (starvingTicks: number) => {
      store.ingest(makeSnapshot({
        ...ROSTER,
        colonists: ROSTER.colonists!.map((c) => (c.id === 3 ? { ...c, starvingTicks } : c)),
      }), { paused: true, speed: 1, error: null });
      await wrapper.vm.$nextTick();
      return wrapper.get('[data-test="starving-3"]').text();
    };
    expect(await at(10)).toBe(`${BALANCE.starvationDeathTicks - 10}t`);
    expect(await at(90)).toBe(`${BALANCE.starvationDeathTicks - 90}t`);
    expect(await at(0)).toBe('—');
  });
});
