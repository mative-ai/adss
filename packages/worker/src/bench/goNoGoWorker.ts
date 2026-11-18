/**
 * The go/no-go's worker (bench/goNoGo.ts), started by the app's bench.html in development only. On any message it runs
 * every case on the v1 scenarios, posts a `case` message as each one ends and the `report` at the end, with the
 * browser it ran in.
 */
import { parseScenario } from '@mpc-simulator/core';

import moose from '../../../../scenarios/moose.json';
import ice from '../../../../scenarios/ice.json';
import muSplit from '../../../../scenarios/mu-split.json';
import pedestrian from '../../../../scenarios/pedestrian.json';
import { runGoNoGo, type GoNoGoMessage } from './goNoGo.ts';

const post = (message: GoNoGoMessage) => self.postMessage(message);

self.onmessage = () => {
  try {
    const scenarios = {
      pedestrian: parseScenario(pedestrian),
      moose: parseScenario(moose),
      ice: parseScenario(ice),
      'mu-split': parseScenario(muSplit),
    };
    const report = runGoNoGo(scenarios, { onCase: (r, done, total) => post({ type: 'case', report: r, done, total }) });
    const { userAgent, hardwareConcurrency } = self.navigator;
    post({ type: 'report', report, environment: { userAgent, hardwareConcurrency } });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
};
