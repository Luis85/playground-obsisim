import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  { ignores: ['demo-vault/', 'node_modules/', 'scripts/', '*.config.*', '.claude/', '.superpowers/', '.obsidian/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: {
        window: 'readonly', document: 'readonly', HTMLElement: 'readonly',
        MouseEvent: 'readonly', KeyboardEvent: 'readonly', getComputedStyle: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
      },
    },
    rules: {
      // Purely-formatting rules that fight this project's verbatim SFC markup
      // (no Prettier is wired in). Severity policy is all-error with an empty
      // warn tier, so these are disabled outright rather than left as warnings
      // that CI would never fail on anyway. See docs/build-ci/quality-gates.md.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  // Lint twins of the fallow boundary zones (.fallowrc.json `boundaries`):
  // these also catch what zones cannot, e.g. the UI importing sim-ecs directly.
  // no-restricted-imports does not merge across config entries (last match
  // wins), so the shell block repeats the sim-ecs ban alongside its own.
  {
    files: ['src/app/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'sim-ecs', message: 'UI and shell talk to the engine only through the GameEngine facade and shared types.' }],
      }],
    },
  },
  {
    files: ['src/view/**', 'src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'sim-ecs', message: 'UI and shell talk to the engine only through the GameEngine facade and shared types.' },
          { name: 'excalibur', message: 'The Obsidian shell talks to rendering only through createGameApp.' },
        ],
      }],
    },
  },
  {
    files: ['src/engine/**', 'src/shared/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'vue', message: 'The engine and shared contracts must stay UI-agnostic.' },
          { name: 'pinia', message: 'The engine and shared contracts must stay UI-agnostic.' },
          { name: 'vue-router', message: 'The engine and shared contracts must stay UI-agnostic.' },
          { name: 'obsidian', message: 'The engine and shared contracts must stay Obsidian-agnostic.' },
          { name: 'excalibur', message: 'The engine and shared contracts must stay renderer-agnostic.' },
        ],
      }],
    },
  },
);
