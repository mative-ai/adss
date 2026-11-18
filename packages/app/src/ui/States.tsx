/**
 * The screens that are not the simulator (Phase 4, the five states): loading while the worker starts, and the error of a
 * run that was dropped or a worker that does not answer (with the way out of each). The simulator itself is the
 * "success" state, with the first scenario already chosen (the "empty" one) and the "partial" one in its warnings.
 */
import { useI18n } from '../i18n/context.tsx';
import { ResetIcon } from './icons.tsx';
import { CARD, CARD_TITLE, MUTED, PRIMARY } from './styles.ts';

export function LoadingState() {
  const { t } = useI18n();
  return (
    <div role="status" className={`${CARD} flex items-center gap-3`}>
      <span
        aria-hidden="true"
        className="block size-2.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/15 motion-safe:animate-pulse"
      />
      <p className="text-base text-clay-950 dark:text-white">{t.loading}</p>
    </div>
  );
}

/** A run the worker dropped (reset starts it again), or a worker that crashed (only a new page helps). */
export function ErrorState({ crashed, message, onReset }: { crashed: boolean; message: string; onReset: () => void }) {
  const { t } = useI18n();
  const e = t.error;
  return (
    <div role="alert" className={`${CARD} flex flex-col items-start gap-4`}>
      <h2 className={CARD_TITLE}>{crashed ? e.crashTitle : e.droppedTitle}</h2>
      <p className={`max-w-[60ch] text-base leading-relaxed ${MUTED}`}>{crashed ? e.crashBody : e.droppedBody}</p>
      <p className={`max-w-[60ch] break-words font-mono text-[13px] ${MUTED}`}>{message}</p>
      {crashed ? (
        <button type="button" className={PRIMARY} onClick={() => window.location.reload()}>
          <ResetIcon />
          {e.reload}
        </button>
      ) : (
        <button type="button" className={PRIMARY} onClick={onReset}>
          <ResetIcon />
          {e.reset}
        </button>
      )}
    </div>
  );
}
