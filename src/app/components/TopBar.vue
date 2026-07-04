<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
const speeds = [1, 2, 4] as const;

function onReset() {
  if (window.confirm('Reset the colony? This cannot be undone.')) void engine.reset();
}
</script>

<template>
  <header class="obsisim-topbar">
    <div class="obsisim-controls">
      <button v-if="store.paused" data-test="play" @click="engine.start()">▶ Play</button>
      <button v-else data-test="pause" @click="engine.pause()">⏸ Pause</button>
      <button data-test="step" :disabled="!store.paused" @click="void engine.stepOnce()">Step</button>
      <button
        v-for="s in speeds"
        :key="s"
        :data-test="`speed-${s}`"
        :class="{ 'is-active': store.speed === s }"
        @click="engine.setSpeed(s)"
      >
        {{ s }}×
      </button>
    </div>
    <div v-if="store.snapshot" class="obsisim-summary">
      <span data-test="tick">Tick {{ store.snapshot.tick }}</span>
      <span>👥 {{ store.snapshot.population }}</span>
      <span>💰 {{ store.snapshot.colonyWealth.toFixed(0) }}</span>
      <span v-if="store.lowFood" class="obsisim-warning" data-test="low-food">⚠ Low food</span>
    </div>
    <button class="obsisim-reset" data-test="reset" @click="onReset">Reset colony</button>
  </header>
</template>
