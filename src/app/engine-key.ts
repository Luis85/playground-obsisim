import type { InjectionKey } from 'vue';
import type { GameEngine } from '../engine/game-engine';

export const ENGINE_KEY: InjectionKey<GameEngine> = Symbol('obsisim-engine');
