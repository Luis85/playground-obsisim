<script setup lang="ts">
import { BUILDINGS, BUILDING_IDS, type BuildingDefId } from '../../engine/content';
import { costLabel } from '../labels';
import { BUILDING_GLYPHS } from '../world/theme';

// The construct catalog as canvas-side buttons: click arms placement mode
// (the parent owns the mode), click again disarms. NOT gated on
// affordability (spec §2.1, increment 10): ordering is a request, so a def
// arms and places whether or not the colony can pay for it today, and the
// queue fills as goods arrive. `affordableDefs` (game-store.ts) is still read
// elsewhere — BuildingsView's tooltip — to tell the player what a def still
// needs; it just no longer refuses anything here, so this component has no
// more use for the store at all.
const props = defineProps<{ armedDefId: BuildingDefId | null }>();
const emit = defineEmits<{ arm: [defId: BuildingDefId]; disarm: [] }>();

function toggle(id: BuildingDefId) {
  if (props.armedDefId === id) emit('disarm');
  else emit('arm', id);
}
</script>

<template>
  <div class="obsisim-build-palette" data-test="build-palette">
    <button
      v-for="id in BUILDING_IDS"
      :key="id"
      :data-test="`palette-${id}`"
      :class="{ 'is-armed': armedDefId === id }"
      @click="toggle(id)"
    >
      <span>{{ BUILDING_GLYPHS[id] }} {{ BUILDINGS[id].name }}</span>
      <span class="obsisim-palette-cost">{{ costLabel(BUILDINGS[id].cost) }}</span>
    </button>
  </div>
</template>
