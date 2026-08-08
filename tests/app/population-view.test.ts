// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import PopulationView from '../../src/app/views/PopulationView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { BALANCE } from '../../src/engine/content/balance';
import { makeSnapshot } from './fixtures';
import type { ColonistSnapshot } from '../../src/shared/snapshot';

// A single idle worker, overridable field by field — hunger is the only
// field this file's cases vary, but the full shape keeps callers honest
// about what a ColonistSnapshot actually carries.
function worker(overrides: Partial<ColonistSnapshot> = {}): ColonistSnapshot {
  return {
    id: 1, hunger: 0, efficiency: 1, buildingId: null, hauling: false,
    haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0,
    haulLegTicks: 0, haulPickupCol: 0, haulPickupRow: 0,
    carrying: 0, toolTicks: 0,
    ...overrides,
  };
}

// Mounts with a fresh testing Pinia each call, so tests never leak state
// between it.each cases the way a shared module-level store would.
function mountPopulationView(colonists: ColonistSnapshot[]) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(PopulationView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  useGameStore().ingest(makeSnapshot({ colonists }), { paused: true, speed: 1, error: null });
  return wrapper;
}

describe('PopulationView', () => {
  // Keyed off BALANCE, not literals, so a balance retune can't silently
  // invalidate this test: views carry no coverage floor, so this is the only
  // gate that would catch a dropped binding or a flipped comparison.
  it.each([
    [0, ''],
    [BALANCE.mealThreshold, 'obsisim-warning'],
    [BALANCE.hungerMax, 'obsisim-negative'],
  ])('hunger %i renders with class %o', async (hunger, expected) => {
    const wrapper = mountPopulationView([worker({ hunger })]);
    await wrapper.vm.$nextTick();
    const cell = wrapper.get('[data-test="hunger-1"]');
    expect(cell.classes()).toEqual(expected === '' ? [] : [expected]);
  });

  // A hauler's own buildingId is null, same as a truly idle worker's — jobLabel
  // must tell them apart via `hauling`, not just render "Idle" for both. Two
  // rows in one mount (rather than two mounts) so the assertion also pins the
  // row ordering matching worker array order, not just the label text.
  it('labels a hauling worker "Hauling" and leaves an idle one "Idle"', async () => {
    const wrapper = mountPopulationView([
      worker({ id: 1, hauling: true }),
      worker({ id: 2 }),
    ]);
    await wrapper.vm.$nextTick();
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0].text()).toContain('Hauling');
    expect(rows[1].text()).toContain('Idle');
  });
});
