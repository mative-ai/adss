/**
 * The pacing of a live run (Phase 4): how many ticks to simulate now, from the wall clock and the
 * playback rate (1 is real time, below it slow motion). It decides how fast the simulation goes, never what it
 * computes (AGENTS.md §5: measured time may change the pacing, never the result).
 *
 * The ticks owed grow with the wall time at the rate (1 kHz at rate 1) and fall as the session simulates them. When
 * the simulation cannot keep up, more than MAX_LAG_TICKS stay owed after a turn: the debt is dropped, so the run goes
 * on at the rate it achieves (automatic slow motion) and says so once; once a second goes by without falling behind,
 * it is back at the requested rate and says so too.
 */

/** Ticks the simulation may fall behind the wall clock before the debt is dropped: 0.2 s of simulated time. */
export const MAX_LAG_TICKS = 200;
/** Playback rates the pacer accepts. */
export const RATE_RANGE = { min: 0.05, max: 4 } as const;
/** Wall time the achieved rate is measured over, ms. */
const WINDOW_MS = 1000;

export type PacerNotice = 'slowMotion' | 'realTime';

export class Pacer {
  private playing = false;
  private rate = 1;
  private last = 0;
  private owed = 0;
  private slow = false;
  /** Wall time since the last fall behind while slow, ms. */
  private steady = 0;
  /** The achieved rate's window: ticks and wall time, and the last full window's value. */
  private windowTicks = 0;
  private windowMs = 0;
  private achieved = 1;

  get isPlaying(): boolean {
    return this.playing;
  }

  get requestedRate(): number {
    return this.rate;
  }

  /** Simulated over wall time in the last second of play (the requested rate before any). */
  get achievedRate(): number {
    return this.achieved;
  }

  /** Whether the run is in automatic slow motion. */
  get slowMotion(): boolean {
    return this.slow;
  }

  play(now: number): void {
    if (this.playing) return;
    this.playing = true;
    this.last = now;
    this.owed = 0;
  }

  pause(): void {
    this.playing = false;
    this.owed = 0;
  }

  /** A new run: paused, out of slow motion, its achieved rate measured afresh; the playback rate stays. */
  reset(): void {
    this.pause();
    this.slow = false;
    this.steady = 0;
    this.windowTicks = 0;
    this.windowMs = 0;
    this.achieved = this.rate;
  }

  setRate(rate: number): void {
    if (!(rate >= RATE_RANGE.min && rate <= RATE_RANGE.max)) {
      throw new RangeError(`The playback rate must be from ${RATE_RANGE.min} to ${RATE_RANGE.max}: ${rate}`);
    }
    this.rate = rate;
    // In slow motion the run goes no faster for a higher rate: until a window measures it, it says what it achieved.
    this.achieved = this.slow ? Math.min(rate, this.achieved) : rate;
    this.windowTicks = 0;
    this.windowMs = 0;
  }

  /** Ticks to simulate now, at `now` (ms): what the wall time since the last call owes at the rate, plus the rest. */
  due(now: number): number {
    if (!this.playing) return 0;
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.owed += elapsed * this.rate;
    this.windowMs += elapsed;
    if (this.slow) this.steady += elapsed;
    return Math.floor(this.owed);
  }

  /** After a turn simulated `ticks`: drops a debt the simulation cannot pay; says when slow motion starts or ends. */
  settle(ticks: number): PacerNotice | null {
    this.owed = Math.max(0, this.owed - ticks);
    this.windowTicks += ticks;
    if (this.windowMs >= WINDOW_MS) {
      this.achieved = this.windowTicks / this.windowMs;
      this.windowTicks = 0;
      this.windowMs = 0;
    }
    if (this.owed > MAX_LAG_TICKS) {
      this.owed = 0;
      this.steady = 0;
      if (!this.slow) {
        this.slow = true;
        // The rate it achieves now, over the window so far: the last full window may predate the fall behind.
        if (this.windowMs > 0) this.achieved = this.windowTicks / this.windowMs;
        return 'slowMotion';
      }
      return null;
    }
    if (this.slow && this.steady >= WINDOW_MS) {
      this.slow = false;
      return 'realTime';
    }
    return null;
  }
}

/**
 * When frames are due while playing: one every `periodMs` of wall time, sent at the turn of the loop that reaches its
 * deadline less `slackMs` (half a turn). The deadlines keep their cadence, so a frame sent a little late brings the
 * next one closer instead of pushing it later, and the frames average the period whatever the turns' length; after a
 * gap of more than a period (a pause, a stalled turn) the cadence starts again from the frame sent.
 */
export class FrameCadence {
  private readonly periodMs: number;
  private readonly slackMs: number;
  private next = Number.NEGATIVE_INFINITY;

  constructor(periodMs: number, slackMs: number) {
    this.periodMs = periodMs;
    this.slackMs = slackMs;
  }

  /** Whether a frame is due at `now` (ms). */
  due(now: number): boolean {
    return now >= this.next - this.slackMs;
  }

  /** A frame went out at `now` (ms), due or not (a pause, a step and a buffer back send one too). */
  sent(now: number): void {
    this.next = (now - this.next > this.periodMs ? now : this.next) + this.periodMs;
  }
}
