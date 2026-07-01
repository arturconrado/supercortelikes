import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#08090d',
        panel: '#101218',
        lime: '#c9ff42',
      },
      boxShadow: { glow: '0 0 48px rgba(201, 255, 66, .12)' },
      animation: { 'fade-in': 'fade-in .35s ease-out both' },
      keyframes: { 'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } } },
    },
  },
  plugins: [],
} satisfies Config;
