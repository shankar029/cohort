/** @type {import('tailwindcss').Config} */
import typography from '@tailwindcss/typography';

// Every color resolves to a CSS variable holding space-separated RGB channels,
// so a single set of Tailwind tokens drives BOTH themes (Catppuccin Mocha = dark,
// Latte = light). The `<alpha-value>` placeholder keeps Tailwind's /opacity
// modifiers working (e.g. bg-surface-1/40, ring-accent-500/70).
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/web/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: v('--ct-bg'),
          1: v('--ct-panel'),
          2: v('--ct-raised'),
          3: v('--ct-hover'),
          border: v('--ct-border'),
        },
        accent: {
          400: v('--ct-accent-text'),
          500: v('--ct-accent-ring'),
          600: v('--ct-accent-fill'),
          700: v('--ct-accent-deep'),
        },
        status: {
          idle: v('--ct-idle'),
          working: v('--ct-blue'),
          input: v('--ct-yellow'),
          blocked: v('--ct-red'),
          done: v('--ct-green'),
        },
        // Remap the neutral text ramp used across the app to Catppuccin's text/
        // overlay scale so all existing text-slate-* classes flip per theme.
        slate: {
          100: v('--ct-t1'),
          200: v('--ct-t2'),
          300: v('--ct-t3'),
          400: v('--ct-t4'),
          500: v('--ct-t5'),
          600: v('--ct-t6'),
          700: v('--ct-t6'),
        },
        // Remap the accent/semantic families the pages already use to Catppuccin
        // hues so everything stays cohesive and theme-aware.
        red: {
          200: v('--ct-red'),
          300: v('--ct-red'),
          400: v('--ct-red'),
          500: v('--ct-red-fill'),
          600: v('--ct-red-fill'),
        },
        rose: { 300: v('--ct-red'), 400: v('--ct-red') },
        emerald: { 300: v('--ct-green'), 400: v('--ct-green'), 500: v('--ct-green') },
        green: { 300: v('--ct-green'), 400: v('--ct-green'), 500: v('--ct-green') },
        blue: {
          200: v('--ct-blue'),
          300: v('--ct-blue'),
          400: v('--ct-blue'),
          500: v('--ct-blue'),
        },
        sky: { 300: v('--ct-sky'), 400: v('--ct-sky'), 500: v('--ct-sky') },
        cyan: { 300: v('--ct-teal'), 400: v('--ct-teal') },
        teal: { 300: v('--ct-teal'), 400: v('--ct-teal') },
        amber: { 300: v('--ct-yellow'), 400: v('--ct-yellow'), 500: v('--ct-yellow') },
        yellow: { 300: v('--ct-yellow'), 400: v('--ct-yellow'), 500: v('--ct-yellow') },
        orange: { 300: v('--ct-peach'), 400: v('--ct-peach') },
        violet: { 300: v('--ct-accent-text'), 400: v('--ct-accent-text') },
        purple: { 300: v('--ct-accent-text'), 400: v('--ct-accent-text') },
      },
      boxShadow: {
        card: '0 1px 2px 0 var(--ct-shadow-sm)',
        pop: '0 12px 40px -8px var(--ct-shadow-lg)',
        glow: '0 0 0 1px rgb(var(--ct-accent-ring) / 0.35), 0 6px 24px -6px rgb(var(--ct-accent-fill) / 0.45)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 1.2s ease-in-out infinite',
        fadeIn: 'fadeIn 0.18s ease-out',
      },
    },
  },
  plugins: [typography],
};
