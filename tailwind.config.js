/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/web/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0a0c12',
          1: '#0f131c',
          2: '#161b27',
          3: '#1e2536',
          border: '#252d3f',
        },
        accent: {
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        status: {
          idle: '#94a3b8',
          working: '#3b82f6',
          input: '#f59e0b',
          blocked: '#ef4444',
          done: '#22c55e',
        },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(0,0,0,0.35)',
        pop: '0 12px 40px -8px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(99,102,241,0.35), 0 6px 24px -6px rgba(79,70,229,0.45)',
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
  plugins: [],
};
