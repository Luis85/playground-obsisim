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
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.relocating }" /> relocating</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.carriedLoad }" /> carrying</span>
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.housing }" /> housing</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.stageMark.child }" /> child</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.stageMark.elder }" /> elder</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.homelessMark }" /> homeless</span>
      <span>⛺ idle camp</span>
    </template>
  </div>
</template>
