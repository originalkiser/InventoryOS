import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0f1117',
        surface: '#161820',
        'surface-2': '#1e2030',
        border: '#2a2d3e',
        cyan: {
          DEFAULT: '#00e5ff',
          dim: '#00b8cc',
        },
        neon: {
          cyan: '#00e5ff',
          green: '#39ff14',
          magenta: '#ff00ff',
          amber: '#ffb300',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'glow-cyan': '0 0 8px rgba(0,229,255,0.4)',
        'glow-green': '0 0 8px rgba(57,255,20,0.4)',
        'glow-magenta': '0 0 8px rgba(255,0,255,0.4)',
        'glow-amber': '0 0 8px rgba(255,179,0,0.4)',
      },
    },
  },
  plugins: [],
}

export default config
