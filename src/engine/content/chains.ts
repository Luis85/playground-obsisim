import type { Chain } from '../../shared/content-types';

export const CHAINS: readonly Chain[] = [
  {
    name: 'Food',
    steps: [
      { building: 'gatherersHut', output: 'berries' },
      { building: 'farm', output: 'wheat' },
      { building: 'mill', output: 'flour' },
      { building: 'bakery', output: 'bread' },
    ],
  },
  {
    name: 'Industry',
    steps: [
      { building: 'forester', output: 'wood' },
      { building: 'sawmill', output: 'planks' },
      { building: 'workshop', output: 'tools' },
    ],
  },
];
