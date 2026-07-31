<script setup lang="ts">
import { ref } from 'vue';

// A click-to-confirm button: first click arms ("Confirm …?"), second click
// emits. Shared by canvas demolish and table demolish so the guard exists
// once. MouseEvent.detail > 1 is the second click of a double-click — it
// must not fall through the arm step straight to confirm (the colony-reset
// guard, same reasoning). Blur disarms so a wandering click can't confirm
// something armed long ago.
defineProps<{ label: string; confirmLabel: string; dataTest: string }>();
const emit = defineEmits<{ confirm: [] }>();
const armed = ref(false);

function onClick(event: MouseEvent) {
  if (event.detail > 1) return;
  if (!armed.value) {
    armed.value = true;
    return;
  }
  armed.value = false;
  emit('confirm');
}
</script>

<template>
  <button :data-test="dataTest" :class="{ 'is-armed': armed }" @click="onClick" @blur="armed = false">
    {{ armed ? confirmLabel : label }}
  </button>
</template>
