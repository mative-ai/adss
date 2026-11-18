/**
 * The colors of the charts, light and dark, from the brand's tokens (`mative-brand`, `references/token.md`). The brand
 * has one accent: the MPC is the green and the ghost a neutral, the same in every chart, and the two are never told
 * apart by color alone: the ghost's line is dashed, each chart names its lines and shows their values in text, and the
 * values are also in a table.
 *
 * Checked with the palette validator of the `dataviz` skill against each theme's surface: the two lines are far apart
 * for normal and for color-blind vision (ΔE 21.6 and 24.9 light, 11.8 and 18.5 dark); the green's contrast on the
 * light surface is 2.9:1, under 3:1, which the values in text and the table make up for. The neutral is under the
 * validator's chroma floor on purpose: it is not a second hue.
 */

export interface ChartTheme {
  ego: string;
  ghost: string;
  /** Axis labels, and the reference line with its label. */
  text: string;
  /** Gridlines: solid hairlines one step off the surface. */
  grid: string;
  /** The card under the chart: the ring around a marker. */
  surface: string;
}

export const CHART_LIGHT: ChartTheme = {
  ego: '#45a630',
  ghost: '#50584b',
  text: '#50584b',
  grid: '#e3e7dd',
  surface: '#f7f8f4',
};

export const CHART_DARK: ChartTheme = {
  ego: '#4db936',
  ghost: '#b0b8a6',
  text: '#b0b8a6',
  grid: '#252f22',
  surface: '#131a12',
};

/** The font of the text drawn on a chart's canvas: the page's, at the size of an axis label. */
export const CHART_FONT = '11px Poppins, system-ui, sans-serif';
