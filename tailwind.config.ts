import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // CSS-variable-backed so dark mode flips them via :root / .dark overrides.
        navy:  'rgb(var(--color-navy) / <alpha-value>)',
        inky:  'rgb(var(--color-inky) / <alpha-value>)',
        sky:   'rgb(var(--color-sky)  / <alpha-value>)',
        cream: 'rgb(var(--color-cream) / <alpha-value>)',
        onyx:  '#000000',
      },
      fontFamily: {
        heading: ['"Chakra Petch"', 'sans-serif'],
        body:    ['"DM Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
