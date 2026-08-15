<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { resolveWorldTheme, type WorldTheme } from '../world/theme';

// Explains the world view's encodings with chips colored from the SAME
// resolved palette the canvas paints with — resolved against this element,
// so vault theme variables apply exactly as they do to the renderer.
const root = ref<HTMLElement | null>(null);
const theme = ref<WorldTheme | null>(null);

onMounted(() => {
  theme.value = resolveWorldTheme((name) => getComputedStyle(root.value!).getPropertyValue(name));
});
</script>

<template>
  <div ref="root" class="obsisim-world-legend" data-test="world-legend">
    <template v-if="theme">
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.producing }" /> producing</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.waitingForInput }" /> waiting for input</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.unstaffed }" /> unstaffed</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.colonistColors[theme.colonistColors.length - 1] }" /> fed colonist</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.colonistColors[0] }" /> starving colonist</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.colonistColors[theme.colonistColors.length - 1], borderColor: theme.workerToolRing }" /> tooled</span>
      <span><i class="obsisim-chip is-bar" :style="{ background: theme.progressFill }" /> batch progress</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.accent }" /> selected</span>
      <span><i class="obsisim-chip is-ghost" :style="{ background: theme.accent }" /> ghost: buildable</span>
      <span><i class="obsisim-chip is-ghost" :style="{ background: theme.danger }" /> ghost: blocked</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.outputFull }" /> output full</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.underConstruction }" /> under construction</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.relocating }" /> relocating</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.carriedLoad }" /> carrying out</span>
      <!-- One entry, not two: a store-to-store transfer is drawn with exactly
           this mark and no other (spec §2.10 — no new colour, no new glyph),
           so a row of its own would promise an encoding the canvas does not
           have. Naming it here is what stops a player reading a dot walking
           between two depots as a delivery to a building that isn't there;
           WHICH hauler is transferring is the Population view's job column. -->
      <span><i class="obsisim-chip is-round" :style="{ background: theme.carriedInput }" /> carrying in (delivery or transfer)</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.housing }" /> housing</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.storing }" /> storing</span>
      <span><i class="obsisim-chip is-round" :style="{ borderColor: theme.progressFill }" /> store fill</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.stageMark.child }" /> child</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.stageMark.elder }" /> elder</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.homelessMark }" /> homeless</span>
      <span>⛺ idle camp</span>
    </template>
  </div>
</template>
