/**
 * Light / dark / system.
 *
 * "System" is a real third state, not a default that collapses into one of the other two: it keeps
 * following the OS after you pick it, so a machine that switches at sunset switches with it. That
 * only works if we hold the choice and re-evaluate on change, which is why this listens to the
 * media query rather than reading it once.
 *
 * The class is also applied by an inline script in index.html before first paint. Without that,
 * every load flashes the wrong theme while React boots.
 */
import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

const KEY = 'eplay-theme';
const OPTIONS = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
];

const read = () => {
  try {
    const v = localStorage.getItem(KEY);
    return OPTIONS.some((o) => o.id === v) ? v : 'system';
  } catch {
    return 'system';
  }
};

const apply = (theme) => {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
};

export function ThemeToggle() {
  const [theme, setTheme] = useState(read);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch { /* private browsing — the theme just does not persist */ }

    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
    >
      {OPTIONS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={theme === id}
          aria-label={label}
          title={label}
          onClick={() => setTheme(id)}
          className={cn(
            'grid h-6 w-6 place-items-center rounded transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            theme === id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
