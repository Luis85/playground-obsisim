<script setup lang="ts">
import { useGameStore } from '../../stores/game-store';
import { useUiStore } from '../../stores/ui-store';
import type { AttentionRow } from '../../stores/game-store';

const store = useGameStore();
const ui = useUiStore();

/**
 * Whether a row does anything at all when clicked. Shared by the click
 * handler's early return below and the template's cursor/hover class, so the
 * two cannot disagree about which rows are live — a row this predicate calls
 * inert but the template still shows a pointer cursor for would be a lie the
 * player discovers on the second click, not the first.
 */
function isInert(row: AttentionRow): boolean {
  return row.subject === null && row.highlight.length === 0;
}

/*
 * The three outcomes of spec §2.3's table, in the order the table gives
 * them, plus the tension this panel resolves — see ui-store.ts's `select`
 * for the store-side half of the reasoning below.
 *
 * A row naming ONE building selects it, but not through `ui.select()`. That
 * action forces `panel = 'inspector'` unconditionally, which is exactly
 * right for a canvas click (§2.1) and exactly wrong here: §2.3's own prose is
 * "the bakery is selected **with the Inspector one click away**", not "and
 * the Inspector opens". Attention is a worklist, not a single-shot picker —
 * swapping it for the Inspector on every row would send the player back to
 * this panel after fixing (or merely reading about) each problem.
 * `ui.selectKeepingPanel` (ui-store.ts) exists for exactly this call: it
 * still cancels an armed move that no longer belongs to the new subject,
 * still cancels an armed place, and still drops a standing highlight —
 * everything `select` normally does except switch the dock away from
 * Attention.
 *
 * A row naming SEVERAL colonists highlights that set and selects nothing —
 * and must ALSO clear any standing selection by hand. The dock keeps a
 * selection alive across a panel switch (§2.1's own rule), so without the
 * explicit `clearSelection()` here, selecting a building and then clicking
 * "3 colonists have no bed" would leave the building selected — and the
 * Inspector, if it happens to be open underneath, still pointed at it —
 * while the pulse said something else entirely. `select({ kind: 'none' })`
 * only clears `highlight` on a NON-none outgoing value (see that method's own
 * comment), which is what lets `clearSelection()` then `setHighlight(...)`
 * land both halves instead of the second call erasing the first.
 *
 * A runway/resource row does NEITHER, and that is not the same as clearing.
 * A bread warning names no building; it has no business deselecting the
 * sawmill the player is looking at. `isInert` above is what tells this case
 * apart from "nothing to highlight" would otherwise look like an accident
 * rather than the rule.
 */
function activate(row: AttentionRow) {
  if (row.subject !== null) {
    ui.selectKeepingPanel(row.subject);
    return;
  }
  if (isInert(row)) return;
  ui.clearSelection();
  ui.setHighlight([...row.highlight]);
}
</script>

<template>
  <!-- Spec §2.9's second named transition: `row.id` is already this list's
       key, so `<TransitionGroup>` in place of the plain `<ul>` costs nothing
       beyond the swap — a row is a fresh id exactly when the condition
       behind it just started being true (see game-store.ts's derivation),
       so "the row just appeared" and "the id just entered this list" are
       the same event, and CSS's `.obsisim-attention-row-enter-*` (styles.css,
       behind `prefers-reduced-motion: no-preference`) plays on it once. A
       row whose MESSAGE changed under an id already present (e.g. a runway
       countdown's remaining ticks) keeps its id and does not replay this —
       intentionally: that is an update, not an appearance. -->
  <TransitionGroup tag="ul" name="obsisim-attention-row" class="obsisim-attention" data-test="attention">
    <li
      v-for="row in store.attention" :key="row.id" :data-test="`attention-${row.id}`"
      :class="[row.severity === 'danger' ? 'obsisim-negative' : 'obsisim-warning', { 'is-inert': isInert(row) }]"
      @click="activate(row)"
    >
      {{ row.message }}
    </li>
    <!-- `is-inert` here too: this row has no click handler at all (no
         `@click`), and without the class it would still pick up
         `.obsisim-attention li`'s pointer cursor and hover highlight from a
         handler it does not carry. A stable string key, not `row.id` (there
         is no row): the empty state is its own permanent slot, not a list
         member the TransitionGroup should ever treat as appearing/leaving. -->
    <li v-if="store.attention.length === 0" key="empty" class="is-inert" data-test="attention-empty">
      Nothing needs attention.
    </li>
  </TransitionGroup>
</template>
