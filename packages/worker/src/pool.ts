/**
 * The frames' buffers (AGENTS.md §5): each frame travels to the main thread in an ArrayBuffer that is transferred, not
 * copied, and comes back with `returnBuffer`. At most `limit` exist for a run: a buffer back is taken only in place of
 * one lent, so an earlier run's buffer of the same size takes the place of one of this run's, never adds to them. While
 * the main thread holds them all, a frame is skipped, never queued: the next one carries the newer state and every
 * telemetry row the skipped one would have (the session keeps its place).
 */
export class BufferPool {
  readonly byteLength: number;
  readonly limit: number;
  private readonly free: ArrayBuffer[] = [];
  private created = 0;
  /** Buffers lent to the main thread and not back yet. */
  private lent = 0;

  constructor(byteLength: number, limit = 4) {
    this.byteLength = byteLength;
    this.limit = limit;
  }

  /** A buffer for the next frame, or undefined while the main thread holds them all. */
  take(): ArrayBuffer | undefined {
    let buffer = this.free.pop();
    if (!buffer) {
      if (this.created >= this.limit) return undefined;
      this.created++;
      buffer = new ArrayBuffer(this.byteLength);
    }
    this.lent++;
    return buffer;
  }

  /** A buffer back from the main thread; one of another size, or one more than were lent (an earlier run's), is dropped. */
  give(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength !== this.byteLength || this.lent === 0) return false;
    this.lent--;
    this.free.push(buffer);
    return true;
  }
}
