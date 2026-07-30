<script setup lang="ts">
import { inject, ref } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
const speeds = [1, 2, 4] as const;

// Two-step reset in place of window.confirm: a native confirm dialog was one
// accidental Enter press away from wiping a colony with no way back. Arming
// just flips a flag and swaps in the confirm/cancel pair below; nothing
// destructive happens until confirmReset() itself is clicked.
//
// setResetArmed(bool) rather than two separate arm/cancel functions: both
// idle->armed and armed->idle are the exact same state write, just with the
// opposite boolean, so one small function covers both template call sites
// (data-test="reset" and data-test="reset-cancel") instead of two near-
// duplicates that would only differ in the literal they assign.
const resetArmed = ref(false);
function setResetArmed(armed: boolean) { resetArmed.value = armed; }
function confirmReset() { resetArmed.value = false; void engine.reset(); }
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
    <button v-if="!resetArmed" class="obsisim-reset" data-test="reset" @click="setResetArmed(true)">Reset colony</button>
    <template v-else>
      <!--
        Cancel MUST render first, in the exact slot "Reset colony" vacated: Vue
        re-renders in a microtask, so a double-click's second event can land
        100-300ms later on whatever now occupies that position. Putting
        Confirm there instead would turn a stray double-click into an
        unrecoverable colony wipe -- worse than the window.confirm this
        replaced. Confirm is offset second instead, so a stray click hits
        Cancel (which only disarms) rather than Confirm.
      -->
      <button data-test="reset-cancel" @click="setResetArmed(false)">Cancel</button>
      <button class="obsisim-reset" data-test="reset-confirm" @click="confirmReset">Confirm reset</button>
    </template>
  </header>
</template>
