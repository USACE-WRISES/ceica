// Colors for every figure, one place for the app, the reports and the workbook
// (ceica/figures/palette.py).
//
// House navy for marks, with direct labels instead of a rainbow: the upper end of viridis (the
// ecorest default) fails the 3:1 non-text contrast on white. Decisions are green; the hover and pin
// highlight is a dark orange that passes contrast as a stroke.

export const NAVY = '#2f4b7c'
export const NAVY_DARK = '#243a61'
export const NAVY_SOFT = '#dbe5f4'
export const MUTED = '#7a8699'
export const FAINT = '#8a94a6'
export const FAINT_FILL = '#f1f4f9'
export const TEXT = '#33415c'
export const TEXT_MUTED = '#646f80'
export const GRID = '#e5e8ee'
export const AXIS = '#98a1b3'
export const DECISION = '#1a7f37'
export const HIGHLIGHT = '#b35900'
export const HIGHLIGHT_HALO = '#ffe2bf'
/** Density layer for very many plans, lightest to darkest: MUTED over white at about 12, 22, 31 and
 * 40 percent, so navy, decision and highlight marks keep 3:1 on every tint. */
export const DENSITY = ['#eff0f3', '#e2e5e9', '#d6d9df', '#cacfd6'] as const

/** Alternative series in line charts (No Action is TEXT, dashed). Each is at least 5.4:1 on white,
 * so a line stays at 4:1 or better on the STAF band tints below. */
export const SERIES = ['#2f4b7c', '#b8420f', '#00795c', '#8f3f71', '#0b7285', '#8a5a00', '#1f5f99', '#5f4b8b'] as const
/** STAF condition bands behind the ECI chart: the STAF band colors at half strength, so every series
 * line keeps its contrast. */
export const STAF_BAND_TINTS: Readonly<Record<string, string>> = {
  'Non-Functioning': '#fadada', 'Functioning-at-Risk': '#faf3d2', Functioning: '#e4ecf8',
}
/** Cost parts, in stack order. */
export const COST_PARTS: ReadonlyMap<string, string> = new Map([
  ['construction', '#2f4b7c'], ['idc', '#5a7bb5'], ['monitoring', '#0b7285'],
  ['adaptive_management', '#9a6700'], ['omrrr', '#7a8699'], ['entered', '#2f4b7c']])
export const EXTRA_PARTS = ['#3d8c8c', '#8c6d3d', '#6d3d8c', '#3d6d8c'] as const

/** R viridis(n) for n up to 8, for teams that want the Utoy look (not used by default). */
export const VIRIDIS: Readonly<Record<number, readonly string[]>> = {
  2: ['#440154', '#FDE725'],
  3: ['#440154', '#21908C', '#FDE725'],
  8: ['#440154', '#46337E', '#365C8D', '#277F8E', '#1FA187', '#4AC16D', '#9FDA3A', '#FDE725'],
}
