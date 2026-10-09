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
        // Surface layers (see index.css): page < card (`cream`) < pop (menus, popovers) and soft (hover / quiet fills).
        page:  'rgb(var(--color-page) / <alpha-value>)',
        pop:   'rgb(var(--color-pop) / <alpha-value>)',
        soft:  'rgb(var(--color-soft) / <alpha-value>)',
        band:  'rgb(var(--color-band) / <alpha-value>)',
        onyx:  '#000000',
        // App chrome (Sidebar/TopBar) — sky-blue bg/dark text in light mode,
        // the original always-dark navy bg/cream text under .dark. See
        // index.css's own comment on --chrome-bg/--chrome-fg.
        chrome: 'rgb(var(--chrome-bg) / <alpha-value>)',
        'chrome-fg': 'rgb(var(--chrome-fg) / <alpha-value>)',
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
        // Variable-backed so a user's font group (see src/hooks/useFontGroup.ts / index.css) can swap them; `brand` stays fixed.
        heading: ['var(--font-heading)'],
        body:    ['var(--font-body)'],
        brand:   ['"Chakra Petch"', 'sans-serif'],
        mono:    ['var(--font-body)'],
      },
    },
  },
  plugins: [],
}

export default config
