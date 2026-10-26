/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // "Pine" — PromptVault's brand colour. Deep, calm, trustworthy; reads as security without the generic SaaS blue.
        brand: {
          50: '#eef7f5',
          100: '#d5ece7',
          200: '#abd9cf',
          300: '#78bfb0',
          400: '#45a08f',
          500: '#1f8574',
          600: '#0f6e5f',
          700: '#0c5a4e',
          800: '#0b4840',
          900: '#0a3b35',
          950: '#05221f',
        },
        canvas: {
          DEFAULT: '#f6f7f9',
          dark: '#09090b',
        },
        zinc: {
          850: '#1e1e22',
        },
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(16 24 40 / 0.05)',
        card: '0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)',
        pop: '0 12px 32px -8px rgb(16 24 40 / 0.18), 0 4px 8px -4px rgb(16 24 40 / 0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': { from: { opacity: '0', transform: 'translateY(4px) scale(.98)' }, to: { opacity: '1', transform: 'none' } },
        'sheet-in': { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'none' } },
        'toast-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'pop-in': 'pop-in 180ms cubic-bezier(.2,.8,.2,1)',
        'sheet-in': 'sheet-in 240ms cubic-bezier(.2,.8,.2,1)',
        'toast-in': 'toast-in 200ms ease-out',
      },
    },
  },
  plugins: [],
}
