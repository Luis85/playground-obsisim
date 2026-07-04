import { createApp, type App } from 'vue';
import { createPinia } from 'pinia';
import type { GameEngine } from '../engine/game-engine';
import AppRoot from './App.vue';
import { ENGINE_KEY } from './engine-key';
import { createGameRouter } from './router';
import { useGameStore } from './stores/game-store';

export async function createGameApp(engine: GameEngine, container: HTMLElement): Promise<App<Element>> {
  const pinia = createPinia();
  const app = createApp(AppRoot);
  app.use(pinia);
  const router = createGameRouter();
  app.use(router);
  app.provide(ENGINE_KEY, engine);

  const store = useGameStore(pinia);
  engine.onUpdate((snapshot, status) => store.ingest(snapshot, status));

  // memory history performs NO automatic initial navigation (unlike web
  // history): push the dashboard route and wait, or the first render is a
  // blank router outlet until the user clicks a tab
  await router.push('/');
  app.mount(container);
  return app;
}
