/**
 * The chrome's icon sprite (spec §2.9). A plain object of SVG path `d`
 * attributes — no dependency, no build step — rendered by `Icon.vue` as
 * `<path :d="ICONS[name]" fill="currentColor" />`.
 *
 * Why this exists instead of an emoji or Obsidian's own icon set: "the chrome
 * uses emoji (👥 💰 ⚒ ⚠). Emoji render differently per platform and cannot be
 * recoloured, so they cannot participate in [the world palette]." Obsidian
 * ships Lucide via `setIcon(el, name)`, which would solve the recolour
 * problem, but `setIcon` lives on the `obsidian` module — and `src/app/`
 * deliberately never imports `obsidian` (only `src/view/` and `src/main.ts`
 * do). That boundary is what keeps this whole layer mountable in jsdom with
 * no Electron runtime underneath it, and every test in `tests/app/` relies
 * on it holding. Threading an icon renderer through the `WORLD_RENDERER_KEY`-
 * style injection seam would work, but is not worth a seam for three glyphs
 * — an inline sprite needs no seam at all, and gets `currentColor` for free,
 * which is the one thing an emoji cannot do.
 *
 * Kept deliberately small: exactly the glyphs `TopBar.vue` and
 * `ResourceStrip.vue` need to stop being emoji. What this file does NOT
 * cover, on purpose: the canvas legend's own `⛺` (`WorldLegend.vue`) and the
 * per-building glyphs `BUILDING_GLYPHS` (`theme.ts`) already draws on the
 * canvas and `BuildPalette.vue` reuses for the rail — those are identity
 * marks that match what is drawn on the map itself, not chrome, and spec
 * §2.9 says as much: "Emoji survives only where the canvas legend already
 * relies on it."
 */
export type IconName = 'population' | 'wealth' | 'warning';

export const ICONS: Record<IconName, string> = {
  // Two heads and shoulders (Material Design's "group" glyph): the top
  // bar's population count.
  population:
    'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  // A coin with a currency mark ("monetization") in its centre: the top
  // bar's colony wealth figure.
  wealth:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z',
  // A triangle with an exclamation bar and dot: TopBar's low-food banner
  // and, per ResourceStrip.vue's own comment, a resource chip whose runway
  // has crossed RUNWAY_WARN_TICKS — the same alarm register `⚠` used to be,
  // now recolourable through the same danger token the rest of the chrome
  // reads (`.obsisim-negative` / `--obsisim-color-danger`).
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
};
