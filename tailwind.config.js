/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/web/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0b0e14',
          1: '#11151f',
          2: '#171c28',
          3: '#1f2635',
          border: '#2a3344',
        },
        status: {
          idle: '#94a3b8',
          working: '#3b82f6',
          input: '#f59e0b',
          blocked: '#ef4444',
          done: '#22c55e',
        },
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
      },
      animation: {
        pulseDot: 'pulseDot 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
