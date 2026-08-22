import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import WorldScreen from './views/WorldScreen.vue';
import BuildingsView from './views/BuildingsView.vue';
import PopulationView from './views/PopulationView.vue';
import EconomyView from './views/EconomyView.vue';

export function createGameRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'dashboard', component: DashboardView },
      { path: '/world', name: 'world', component: WorldScreen },
      { path: '/buildings', name: 'buildings', component: BuildingsView },
      { path: '/population', name: 'population', component: PopulationView },
      { path: '/economy', name: 'economy', component: EconomyView },
    ],
  });
}
