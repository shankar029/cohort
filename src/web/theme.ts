import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
/** A second, independent axis layered on top of dark/light. */
export type Palette = 'default' | 'comic';

const STORAGE_KEY = 'ateam-theme';
const PALETTE_KEY = 'ateam-palette';

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

/** Apply a theme to <html> (class + native color-scheme). Leaves the palette
 * class (`comic`) untouched — the two axes are independent. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);
  root.style.colorScheme = theme;
  // Nudge a synchronous reflow so the persistent app shell re-rasters the new
  // CSS-variable colors immediately on toggle (avoids a stale composited layer).
  void root.offsetHeight;
}

/** The palette the user explicitly chose; defaults to the standard look. */
export function resolvedPalette(): Palette {
  try {
    return localStorage.getItem(PALETTE_KEY) === 'comic' ? 'comic' : 'default';
  } catch {
    return 'default';
  }
}

/** Apply a palette to <html> as the `comic` class (additive over dark/light). */
export function applyPalette(palette: Palette): void {
  const root = document.documentElement;
  root.classList.toggle('comic', palette === 'comic');
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

/** React hook: current palette + a toggle that persists the choice. */
export function usePalette(): {
  palette: Palette;
  toggle: () => void;
  setPalette: (p: Palette) => void;
} {
  const [palette, setPaletteState] = useState<Palette>(resolvedPalette);

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  const setPalette = useCallback((p: Palette) => {
    try {
      localStorage.setItem(PALETTE_KEY, p);
    } catch {
      /* ignore storage failures (private mode) */
    }
    setPaletteState(p);
  }, []);

  const toggle = useCallback(() => {
    setPalette(resolvedPalette() === 'comic' ? 'default' : 'comic');
  }, [setPalette]);

  return { palette, toggle, setPalette };
}
