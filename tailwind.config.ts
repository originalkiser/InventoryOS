import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy:  '#002745',
        inky:  '#4F7489',
        sky:   '#B7E0DE',
        onyx:  '#000000',
        cream: '#F2F1E6',
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
