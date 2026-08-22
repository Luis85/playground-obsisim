import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import WorldScreen from './views/WorldScreen.vue';
import LedgerView from './views/LedgerView.vue';

// Five routes become two (Task 12, spec §2.5): the canvas is the primary
// play surface now, and Dashboard/Buildings/Population/Economy — each its
// own tab through increment 11 — collapse into one Ledger route that
// composes all four views in sequence. `/world` is gone too: WorldScreen
// simply IS `/` now, nothing shares the shell with it.
export function createGameRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'world', component: WorldScreen },
      { path: '/ledger', name: 'ledger', component: LedgerView },
    ],
  });
}
