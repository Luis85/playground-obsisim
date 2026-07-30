<script setup lang="ts">
/* global MouseEvent -- this file's eslint config only declares window/document as
   globals for .vue script blocks; MouseEvent is still a real DOM type from
   tsconfig's "DOM" lib, just one no-undef doesn't know about here. */
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

// A double-click's second event can land on Confirm even with Cancel back in
// the arming button's slot: Confirm's own margin/gap only clears that slot
// when "Cancel" is wide enough relative to "Reset colony", and both widths
// depend on the user's Obsidian theme font, so no layout arrangement can be
// relied on to keep a stray double-click off Confirm. MouseEvent.detail is
// theme-independent: it's 2 on a double-click's second click, 1 on a
// deliberate single click, and 0 for keyboard activation (Enter/Space), so
// gating on detail <= 1 blocks the double-click without breaking keyboard use.
function confirmReset(event: MouseEvent) {
  if (event.detail > 1) return;
  resetArmed.value = false;
  void engine.reset();
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
    <button v-if="!resetArmed" class="obsisim-reset" data-test="reset" @click="setResetArmed(true)">Reset colony</button>
    <template v-else>
      <!--
        Cancel renders first, in the slot "Reset colony" vacated, as defence
        in depth: Vue re-renders in a microtask, so a double-click's second
        event can land 100-300ms later on whatever now occupies that
        position, and this ordering means a stray click there hits the
        harmless Cancel rather than Confirm. But it is NOT what makes this
        safe -- Confirm's actual footprint (offset by margin-left + gap from
        its CSS) only clears this slot when "Cancel" happens to be wide
        enough relative to "Reset colony", and both widths depend on the
        user's Obsidian theme font. The real guard is confirmReset()'s
        MouseEvent.detail check, which is layout- and theme-independent.
      -->
      <button data-test="reset-cancel" @click="setResetArmed(false)">Cancel</button>
      <button class="obsisim-reset" data-test="reset-confirm" @click="confirmReset">Confirm reset</button>
    </template>
  </header>
</template>
