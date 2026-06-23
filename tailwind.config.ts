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
        // OutlierOS static color namespace
        sb: {
          navy:   '#002745',
          inky:   '#4F7489',
          sky:    '#B7E0DE',
          onyx:   '#000000',
          cream:  '#F2F1E6',
          red:    '#C0392B',
          orange: '#E67E22',
          green:  '#2ECC71',
        },
      },
      fontFamily: {
        heading: ['"Chakra Petch"', 'sans-serif'],
        body:    ['"DM Mono"', 'monospace'],
        brand:   ['"Chakra Petch"', 'sans-serif'],
        mono:    ['"DM Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
