/**
 * What the charts share (Phase 4): one redraw for all of them when the run's history has grown, and one
 * cursor, the instant the pointer or the keyboard is at on any chart, which every chart then marks and reads its
 * values at. No React state passes through here: a chart redraws itself when it is told to.
 */

/** The instant under the cursor, s; null when there is none and the charts read the run's latest values. */
export class ChartCursor {
  private time: number | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): number | null => this.time;

  set(time: number | null): void {
    if (time === this.time) return;
    this.time = time;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export class ChartBus {
  readonly cursor = new ChartCursor();
  private readonly drawers = new Set<() => void>();

  /** Adds a chart's redraw; the function returned takes it out. */
  register(draw: () => void): () => void {
    this.drawers.add(draw);
    return () => this.drawers.delete(draw);
  }

  /** Redraws every chart from the history as it is now. */
  draw(): void {
    for (const draw of this.drawers) draw();
  }
}
