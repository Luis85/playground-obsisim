// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import SelectionPanel from '../../src/app/components/SelectionPanel.vue';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot } from './fixtures';
import type { BuildingSnapshot } from '../../src/shared/snapshot';

function mountPanel(buildingId = 7, building: Partial<BuildingSnapshot> = {}) {
  const wrapper = mount(SelectionPanel, {
    props: { buildingId },
    global: { plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })] },
  });
  useGameStore().ingest(makeSnapshot({
    buildings: [makeBuilding(7, {
      defId: 'bakery', col: 6, row: 3, workers: 1, workerSlots: 2, state: 'producing',
      ...building,
    })],
  }), { paused: true, speed: 1, error: null });
  return wrapper;
}

describe('SelectionPanel', () => {
  it('shows the selected building: name, tile, staffing, state label', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    const panel = wrapper.find('[data-test="selection-panel"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('Bakery');
    expect(panel.text()).toContain('(6, 3)');
    expect(panel.text()).toContain('1/2 workers');
    expect(panel.text()).toContain('Producing');
  });

  it('emits move and close', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="selection-move"]').trigger('click');
    expect(wrapper.emitted('move')).toHaveLength(1);
    await wrapper.find('[data-test="selection-close"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('demolish emits only after the two-step confirm, and never on a double-click', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    const demolish = wrapper.find('[data-test="selection-demolish"]');
    await demolish.trigger('click');
    expect(wrapper.emitted('demolish')).toBeUndefined();
    expect(demolish.text()).toContain('Confirm');
    await demolish.trigger('click', { detail: 2 }); // double-click bypass attempt
    expect(wrapper.emitted('demolish')).toBeUndefined();
    await demolish.trigger('click');
    expect(wrapper.emitted('demolish')).toHaveLength(1);
  });

  it('renders nothing once the building has left the snapshot', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(false);
  });

  it('reports the goods waiting at the selected building', async () => {
    const wrapper = mountPanel(7, { buffered: 4 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-waiting"]').text()).toContain('4');
  });

  // buffered (4) and inputBuffered (9) are deliberately distinct, so an
  // In span bound to the wrong field changes this assertion rather than
  // coinciding with the Waiting one above.
  it('reports the goods waiting in the input buffer alongside the output buffer', async () => {
    const wrapper = mountPanel(7, { buffered: 4, inputBuffered: 9 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-input"]').text()).toContain('9');
  });

  // held (41) and capacity (60) are distinct, so a Stored span reading either
  // field into the wrong slot changes this assertion. The producer case
  // (storage: 0, the fixture default) proves the line does not appear for
  // every building — only a store has one to show.
  it('shows a storehouse\'s contents against capacity, and hides it for a producer', async () => {
    const store = mountPanel(7, { defId: 'storehouse', state: 'storing', stored: 41, storage: 60 });
    await store.vm.$nextTick();
    expect(store.find('[data-test="selection-storage"]').text()).toBe('Stored: 41 / 60');

    const producer = mountPanel(7, {});
    await producer.vm.$nextTick();
    expect(producer.find('[data-test="selection-storage"]').exists()).toBe(false);
  });

  // relocatingTicks: 9 is deliberately distinct from every other numeric field
  // on this fixture (col 6, row 3, workers 1, workerSlots 2) — a mis-binding
  // to any neighbour would render a different number and fail the exact match.
  it('shows the remaining downtime for a relocating building', async () => {
    const wrapper = mountPanel(7, { state: 'relocating', relocatingTicks: 9 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-relocating"]').text()).toBe('Relocating: 9t left');
    expect(wrapper.text()).toContain('Relocating');
  });

  it('shows no downtime line for a settled building', async () => {
    const wrapper = mountPanel(7, { state: 'producing', relocatingTicks: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-relocating"]').exists()).toBe(false);
  });

  // The construction countdown, alongside the relocating one above for the
  // same reason Step 1's grep pairs the two files. constructionTicks (14) is
  // distinct from every other numeric field on the fixture, and the shortfall
  // is asserted alongside it — the only way this panel can tell a site that
  // is waiting from one that is stuck.
  it('shows the construction countdown and the per-material shortfall for a site', async () => {
    const wrapper = mountPanel(7, {
      state: 'underConstruction', constructionTicks: 14, constructionNeeds: { wood: 9, planks: 2 },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-construction"]').text()).toBe('Under construction: 14t left');
    expect(wrapper.find('[data-test="selection-needs"]').text()).toBe('Needs: 9 Wood, 2 Planks');
    expect(wrapper.text()).toContain('Under construction'); // the state label too, via BUILDING_STATE_LABELS
  });

  it('shows no construction lines for a settled building', async () => {
    const wrapper = mountPanel(7, { state: 'producing', constructionTicks: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-construction"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="selection-needs"]').exists()).toBe(false);
  });
});
