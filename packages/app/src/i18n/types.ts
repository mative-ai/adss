/**
 * The copy of the screens (Phase 4): one typed dictionary per language, it, en and es, every key in all
 * three and actually translated (AGENTS.md §4). `{name}` marks a value the screen puts in; the three languages of a
 * string carry the same marks (i18n.test.ts). The text is short sentences, with an initial capital in titles and no
 * exclamation marks; products keep their English names.
 */
import type { ScenarioId } from '../sim/scenarios.ts';

export const LANGUAGES = ['it', 'en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

type Maneuver = 'keep' | 'brake' | 'left' | 'right';
type Reason = 'cruise' | 'hold' | 'challenged' | 'switch' | 'locked' | 'clear' | 'noFeasible' | 'solverFailed';

export interface Dictionary {
  appName: string;
  /** What the simulator is, in a sentence. */
  intro: string;
  /** "Educational simulation, not for homologation": on every screen. */
  disclaimer: string;
  /** The label of every result: simulated, never measured. */
  simulation: string;
  skipToContent: string;
  /** The theme switch of the navbar: the group's name, then the name of each choice. */
  theme: { label: string; light: string; dark: string; system: string };
  loading: string;
  /** A run dropped by an error, and a worker that does not answer. */
  error: {
    droppedTitle: string;
    droppedBody: string;
    reset: string;
    crashTitle: string;
    crashBody: string;
    reload: string;
    /** `{message}`: what the worker refused. */
    refused: string;
  };
  /** Automatic slow motion; `{rate}` is the rate it keeps. */
  slow: { title: string; body: string };
  scenario: {
    heading: string;
    names: Record<ScenarioId, string>;
    summaries: Record<ScenarioId, string>;
  };
  controls: {
    heading: string;
    play: string;
    pause: string;
    step: string;
    stepHint: string;
    reset: string;
    /** The vehicle's top speed: its name, its two steps (`{step}` km/h) and what it does (`{speed}`: the scenario's). */
    speed: string;
    speedDown: string;
    speedUp: string;
    speedHint: string;
    ghost: string;
    ghostHint: string;
    keys: string;
  };
  view: {
    /** The switch between the two views, and its two choices. */
    mode: string;
    mode3d: string;
    modeTop: string;
    /** The accessible names of the drawings: the top view, the 3D scene and the mini-map over it. */
    label: string;
    label3d: string;
    minimap: string;
    loading3d: string;
    /** The 3D view cannot be drawn on this device: the top view stays (the "partial" state). */
    noWebgl: string;
    /** The realistic scene leans the vehicle's body with its accelerations: an effect, not a result of the run. */
    lean: string;
    /** How the 3D view is moved with a mouse, and the button that gives the camera back to the road. */
    orbit: string;
    resetView: string;
    ego: string;
    ghost: string;
    chosenPlan: string;
    otherPlans: string;
    obstacle: string;
    detected: string;
    /** The name of a surface by its id, for the legend. */
    surfaces: Record<'dry' | 'wet' | 'snow' | 'ice', string>;
    /** `{surface}` and `{mu}`: a zone of the road with a friction coefficient. */
    zone: string;
  };
  readouts: {
    heading: string;
    time: string;
    speed: string;
    steering: string;
    ax: string;
    ay: string;
    distance: string;
    ghostSpeed: string;
  };
  /** The charts of the run; the speed, the steering and the two accelerations take their names from `readouts`. */
  charts: {
    heading: string;
    gg: string;
    /** The value read beside the g-g diagram: the two accelerations together. */
    ggTotal: string;
    ttc: string;
    ttcHint: string;
    solver: string;
    solverHint: string;
    /** The line the computation time is read against. */
    period: string;
    /** `{title}`: the accessible name of a chart's cursor, moved with the arrow keys. */
    scrub: string;
    /** `{time}`: the instant under the cursor. */
    at: string;
    table: string;
    tableNote: string;
  };
  decision: {
    heading: string;
    intro: string;
    maneuvers: Record<Maneuver, string>;
    chosen: string;
    feasible: string;
    infeasible: string;
    notSolved: string;
    cost: string;
    ttc: string;
    impact: string;
    reasons: Record<Reason, string>;
    waiting: string;
    /** `{ms}`: the time of the last control step, measured in the worker. */
    stepTime: string;
  };
  events: {
    heading: string;
    empty: string;
    who: { ego: string; ghost: string };
    /** `{who}`, `{obstacle}`, `{time}`. */
    trigger: string;
    /** `{who}`, `{obstacle}`, `{speed}` (km/h), `{time}`. */
    collision: string;
    /** `{who}`, `{time}`. */
    roadEnd: string;
    /** `{time}`. */
    end: string;
    obstacles: Record<string, string>;
  };
  report: {
    heading: string;
    /** `{obstacle}`. */
    hit: string;
    clear: string;
    columns: { ego: string; ghost: string };
    rows: {
      impactSpeed: string;
      minTtc: string;
      stoppingDistance: string;
      lateralDeviation: string;
      lateralAccel: string;
      sideslip: string;
      finalSpeed: string;
      distance: string;
      duration: string;
    };
    none: string;
  };
}
