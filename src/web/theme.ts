import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'ateam-theme';

/** The theme the user explicitly chose, if any. */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

/** The OS preference, used only when the user hasn't chosen. */
export function systemTheme(): Theme {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function resolvedTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

/** Apply a theme to <html> (class + native color-scheme). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);
  root.style.colorScheme = theme;
  // Nudge a synchronous reflow so the persistent app shell re-rasters the new
  // CSS-variable colors immediately on toggle (avoids a stale composited layer).
  void root.offsetHeight;
}

/** React hook: current theme + a toggle that persists the choice. */
export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(resolvedTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore storage failures (private mode) */
    }
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return { theme, toggle, setTheme };
}
