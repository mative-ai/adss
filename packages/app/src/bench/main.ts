/**
 * The go/no-go page (bench.html), for development only: `npm run dev`, then /bench.html; the production build has
 * index.html alone. It starts the benchmark in a module worker (packages/worker/src/bench), lists each case as it
 * ends, shows the report as JSON, puts the verdict in the title and leaves the last message on `window.goNoGo` for
 * the browser automation that reads it. It computes nothing itself.
 */
import type { GoNoGoMessage } from '../../../worker/src/bench/goNoGo.ts';

declare global {
  interface Window {
    goNoGo?: GoNoGoMessage;
  }
}

const progress = document.getElementById('progress');
const output = document.getElementById('report');
const ms = (v: number) => v.toFixed(2);

const worker = new Worker(new URL('../../../worker/src/bench/goNoGoWorker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (event: MessageEvent<GoNoGoMessage>) => {
  const message = event.data;
  if (message.type === 'case') {
    const r = message.report;
    const line =
      `${message.done}/${message.total} ${r.name}: ${r.qps} QPs, step p95 ${ms(r.step.p95)} ms, ` +
      `agreeing ${r.agreeing}/${r.cycles} (closed loops ${r.closedLoopAgreeing}/${r.closedLoopCycles})`;
    if (progress) progress.textContent += `${line}\n`;
    return;
  }
  window.goNoGo = message;
  if (message.type === 'report') {
    document.title = `go/no-go: ${message.report.go ? 'GO' : 'NO-GO'}`;
    if (output)
      output.textContent = JSON.stringify({ ...message, report: { ...message.report, cases: undefined } }, null, 2);
  } else {
    document.title = 'go/no-go: error';
    if (output) output.textContent = message.message;
  }
};
worker.postMessage('start');
