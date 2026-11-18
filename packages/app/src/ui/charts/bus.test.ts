/**
 * What the charts share (bus.ts): one redraw reaches every chart that registered and none that left, and the cursor
 * tells its listeners only when the instant changes.
 */
import { describe, expect, it } from 'vitest';

import { ChartBus } from './bus.ts';

describe('ChartBus', () => {
  it('redraws every chart that registered, and not one that left', () => {
    const bus = new ChartBus();
    const drawn: string[] = [];
    const leave = bus.register(() => drawn.push('speed'));
    bus.register(() => drawn.push('steering'));
    bus.draw();
    expect(drawn).toEqual(['speed', 'steering']);
    leave();
    bus.draw();
    expect(drawn).toEqual(['speed', 'steering', 'steering']);
  });

  it('tells the listeners of the cursor when the instant changes, and only then', () => {
    const { cursor } = new ChartBus();
    let told = 0;
    const leave = cursor.subscribe(() => told++);
    expect(cursor.get()).toBeNull();
    cursor.set(1.5);
    cursor.set(1.5);
    expect(told).toBe(1);
    expect(cursor.get()).toBe(1.5);
    cursor.set(null);
    expect(told).toBe(2);
    leave();
    cursor.set(3);
    expect(told).toBe(2);
    expect(cursor.get()).toBe(3);
  });
});
