/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        ok: '#10b981',
        warn: '#f59e0b',
        bad: '#ef4444',
        ink: '#0b0f1a',
        panel: '#111827',
      },
    },
  },
  plugins: [],
};
