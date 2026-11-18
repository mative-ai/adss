/**
 * The log's lines (eventText.ts): each kind of the run's events reads in the three languages with the time, who and what,
 * a speed shown as a size, an obstacle the dictionary does not know by its id; the pacing's notices are not in the log.
 */
import { describe, expect, it } from 'vitest';

import { DICTIONARIES, numberFormatter } from '../i18n/index.ts';
import { eventText } from './eventText.ts';

const it_ = { t: DICTIONARIES.it, n: numberFormatter('it') };

describe('eventText', () => {
  it('writes a trigger and a collision with the time, who and what', () => {
    expect(eventText({ kind: 'trigger', tick: 2945, obstacle: 'pedestrian', vehicle: 'ego' }, it_.t, it_.n)).toBe(
      '2,95 s · MPC: pedone entra in scena',
    );
    expect(
      eventText({ kind: 'collision', tick: 7390, obstacle: 'stopped-car', speed: 10, vehicle: 'ghost' }, it_.t, it_.n),
    ).toBe('7,39 s · Fantasma: urto con auto ferma a 36,0 km/h');
  });

  it('shows the closing speed as a size, even when the ego was struck from behind', () => {
    const text = eventText(
      { kind: 'collision', tick: 100, obstacle: 'moose', speed: -5, vehicle: 'ego' },
      it_.t,
      it_.n,
    );
    expect(text).toContain('18,0 km/h');
  });

  it('writes the end of the road and of the run, in every language', () => {
    expect(eventText({ kind: 'roadEnd', tick: 4000, vehicle: 'ego' }, it_.t, it_.n)).toBe(
      '4,00 s · MPC: fine della strada',
    );
    expect(eventText({ kind: 'end', tick: 8000 }, DICTIONARIES.en, numberFormatter('en'))).toBe(
      '8.00 s · End of the run',
    );
    expect(eventText({ kind: 'end', tick: 8000 }, DICTIONARIES.es, numberFormatter('es'))).toBe(
      '8,00 s · Fin de la prueba',
    );
  });

  it('falls back on the id of an obstacle it has no name for', () => {
    expect(eventText({ kind: 'trigger', tick: 1000, obstacle: 'cone', vehicle: 'ego' }, it_.t, it_.n)).toBe(
      '1,00 s · MPC: cone entra in scena',
    );
  });

  it('leaves the pacing notices and the reset out of the log', () => {
    for (const event of [{ kind: 'slowMotion', rate: 0.4 }, { kind: 'realTime' }, { kind: 'reset' }] as const) {
      expect(eventText(event, it_.t, it_.n)).toBeNull();
    }
  });
});
