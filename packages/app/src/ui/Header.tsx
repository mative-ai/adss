/**
 * The common navbar of the Mative sites (`mative-brand`, `references/navbar.md`), the version a one-page product needs:
 * a floating glass bar with the wordmark on a green block at the left, the product's name, the theme switch, and the one
 * action on a green block at the right. No menu (there is one screen) and no language switch: the language comes from
 * the access token. The wordmark is the brand's asset (`assets/mative-wordmark.svg`) inline, in `ink`, raised a tenth
 * of its height.
 */
import { LANDING_URL } from '../access.ts';
import { useI18n } from '../i18n/context.tsx';
import { ExternalIcon } from './icons.tsx';
import { ThemeSwitch } from './ThemeSwitch.tsx';

function Wordmark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 455 95"
      fill="none"
      className="h-[18px] w-auto -translate-y-[10%] text-ink md:h-5"
    >
      <path
        fill="currentColor"
        d="M0 93.0188V28.1101H24.1491V41.7818C28.3656 31.9433 35.7765 27.0879 46.2539 27.0879C56.7313 27.0879 62.6088 31.6877 63.7588 41.0152C67.7197 32.8377 76.1528 27.0879 88.0357 27.0879C103.88 27.0879 111.418 35.3931 111.418 54.9424V93.0188H87.269V55.198C87.269 49.7037 84.8413 46.765 79.3471 46.765C72.3196 46.765 69.5086 51.3648 68.6142 57.8812C68.1031 61.0755 67.8475 65.9309 67.8475 72.3196V93.0188H43.1873L43.6984 92.3799V55.198C43.6984 50.4704 40.8874 47.5316 35.7765 47.5316C28.7489 47.5316 25.8102 51.3648 24.9158 57.8812C24.4047 61.0755 24.1491 65.9309 24.1491 72.3196V93.0188H0ZM124.195 88.2912C120.618 84.3302 118.829 80.1137 118.829 75.3861C118.829 62.7366 126.623 56.2202 146.428 55.7091L166.361 55.198C166.361 55.0702 166.361 54.8147 166.361 54.6869C166.361 47.7871 163.677 44.7206 155.117 44.7206C147.578 44.7206 143.489 46.5094 142.85 50.2148L120.746 47.9149C121.896 38.5875 128.412 32.7099 137.101 29.26C141.445 27.599 148.345 26.8324 157.544 26.8324C158.055 26.8324 158.439 26.8324 158.95 26.8324C167.766 26.9601 175.049 28.7489 180.671 32.4544C186.293 36.1598 189.104 42.5484 189.104 51.4925V71.8085H198.687V93.0188H183.099C176.455 93.0188 172.494 89.3134 172.494 82.6692V77.3027C168.022 90.08 159.589 94.2965 143.361 94.2965C134.162 94.2965 127.773 92.2522 124.195 88.2912ZM382.808 60.4367C382.808 37.4375 395.713 26.7046 419.096 26.7046C432.001 26.7046 441.201 29.6434 446.695 35.6487C452.189 41.654 455 49.576 455 59.67V64.781H406.702C406.83 73.0862 410.79 78.0694 419.351 78.1971C419.479 78.1971 419.735 78.1971 419.862 78.1971C426.762 78.1971 430.979 74.3639 431.873 71.2974H455C454.617 78.3249 451.295 83.8191 444.906 88.0357C438.517 92.2522 429.956 94.2965 419.224 94.2965C406.83 94.2965 397.758 91.23 391.752 84.9691C385.747 78.836 382.808 70.6585 382.808 60.4367ZM201.754 28.1101H212.614V17.6327L236.764 10.0941V28.1101H253.374V49.0649H236.508V72.1918H256.568V93.0188H224.114C216.575 93.0188 212.359 88.8023 212.359 81.2637V49.0649H201.754V28.1101ZM303.844 28.7489H327.738L342.432 77.0472L357.509 29.26H380.508L359.298 93.0188H325.438L303.844 28.7489ZM263.724 49.0649V28.1101H285.701C293.367 28.1101 297.839 32.071 297.839 39.6097L298.478 93.0188H274.073V49.0649H263.724ZM270.879 10.8607C270.879 10.7329 270.879 10.6052 270.879 10.4774C270.879 3.70542 275.99 0 284.04 0C292.217 0 297.711 3.70542 297.711 10.8607C297.711 18.016 292.345 21.7214 284.04 21.7214C275.479 21.7214 271.007 18.1438 270.879 10.8607ZM406.446 54.6869H432.256C432.256 46.6372 427.018 42.6762 419.479 42.6762C411.94 42.6762 406.446 46.6372 406.446 54.6869ZM141.317 71.1696C141.317 74.6195 144.384 76.9194 149.495 76.9194C153.711 76.9194 157.416 75.7694 160.866 73.3418C164.188 70.9141 165.849 68.2308 165.849 65.0365L150.644 65.8031C143.361 66.1865 141.317 68.1031 141.317 71.1696Z"
      />
    </svg>
  );
}

export function Header() {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-40 px-2 pt-2 md:px-4 md:pt-3 lg:px-6">
      <div className="mx-auto flex h-[3.25rem] max-w-[1360px] items-stretch justify-between overflow-hidden rounded-2xl border border-white/70 bg-white/85 shadow-[0_10px_40px_-18px_rgba(20,24,18,0.35)] backdrop-blur-xl dark:border-white/10 dark:bg-night-900/85">
        <a
          href="/"
          aria-label={t.appName}
          className="flex items-center gap-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        >
          <span className="flex h-full items-center bg-primary px-4 transition duration-200 hover:bg-primary-400 md:px-5">
            <Wordmark />
          </span>
          {/* On a narrow screen the title under the bar says it; the link keeps its name for a screen reader. */}
          <span className="hidden whitespace-nowrap font-neu text-base tracking-tight text-clay-950 sm:inline md:text-lg dark:text-white">
            {t.appName}
          </span>
        </a>
        <div className="flex items-stretch">
          <ThemeSwitch />
          <a
            href={LANDING_URL}
            className="flex items-center gap-1.5 whitespace-nowrap bg-primary px-3 text-sm font-semibold text-ink transition duration-200 hover:bg-primary-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink sm:px-4 sm:text-[15px] md:px-5"
          >
            {t.contact}
            <span className="hidden sm:inline-flex">
              <ExternalIcon />
            </span>
          </a>
        </div>
      </div>
    </header>
  );
}
