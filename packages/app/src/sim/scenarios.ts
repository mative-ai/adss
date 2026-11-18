/**
 * The v1 scenarios the screen offers (Phase 3): the files of `scenarios/`, sent to the worker as they
 * are (it validates them). They hold ids only; the names and descriptions live in the dictionaries (i18n/).
 */
import moose from '../../../../scenarios/moose.json';
import ice from '../../../../scenarios/ice.json';
import muSplit from '../../../../scenarios/mu-split.json';
import pedestrian from '../../../../scenarios/pedestrian.json';

export const SCENARIOS = [
  { id: 'pedestrian', json: pedestrian },
  { id: 'moose', json: moose },
  { id: 'ice', json: ice },
  { id: 'mu-split', json: muSplit },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]['id'];

/** The scenario the screen opens on (the empty state: the first one is already selected). */
export const FIRST_SCENARIO: ScenarioId = 'pedestrian';

export const scenarioJson = (id: string): unknown => SCENARIOS.find((s) => s.id === id)?.json;

/** The speed a scenario is written for, km/h: the one its vehicle holds until it has to brake. */
export const scenarioSpeedKmh = (id: string | null): number | undefined =>
  SCENARIOS.find((s) => s.id === id)?.json.speed.reference;
