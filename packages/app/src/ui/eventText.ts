/**
 * An event of the run as a line of the log (Phase 4): when it happened, who it happened to and what. The
 * pacing's notices (slow motion, real time) and the reset are not part of the run's log: the screen shows them elsewhere.
 */
import type { SessionEvent } from '@mpc-simulator/worker';

import { format, type Dictionary, type NumberFormatter } from '../i18n/index.ts';

const TICK_HZ = 1000;

export function eventText(event: SessionEvent, t: Dictionary, n: NumberFormatter): string | null {
  switch (event.kind) {
    case 'trigger':
      return format(t.events.trigger, {
        time: n(event.tick / TICK_HZ, 2),
        who: t.events.who[event.vehicle],
        obstacle: t.events.obstacles[event.obstacle] ?? event.obstacle,
      });
    case 'collision':
      return format(t.events.collision, {
        time: n(event.tick / TICK_HZ, 2),
        who: t.events.who[event.vehicle],
        obstacle: t.events.obstacles[event.obstacle] ?? event.obstacle,
        // The closing speed along the road, signed (negative when the ego is struck from behind): shown as a size.
        speed: n(Math.abs(event.speed) * 3.6, 1),
      });
    case 'roadEnd':
      return format(t.events.roadEnd, { time: n(event.tick / TICK_HZ, 2), who: t.events.who[event.vehicle] });
    case 'end':
      return format(t.events.end, { time: n(event.tick / TICK_HZ, 2) });
    case 'slowMotion':
    case 'realTime':
    case 'reset':
      return null;
  }
}
