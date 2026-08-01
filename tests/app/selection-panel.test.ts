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
});
