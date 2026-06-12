/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'
import path from 'path'

// Unique per build — the git sha in CI, else a timestamp locally. Embedded in
// the app AND written to version.json so the running app can detect new deploys.
const BUILD_ID = (process.env.GITHUB_SHA?.slice(0, 8)) || String(Date.now())

// Writes version.json into the build output so the app can poll it.
function versionFilePlugin() {
  return {
    name: 'write-version-json',
    closeBundle() {
      try {
        writeFileSync(
          path.resolve(__dirname, 'dist/version.json'),
          JSON.stringify({ buildId: BUILD_ID, builtAt: new Date().toISOString() })
        )
      } catch { /* ignore (e.g. non-build runs) */ }
    },
  }
}

export default defineConfig({
  // '/InventoryOS/' for GitHub Pages (repo subpath); change to '/' if using a custom domain
  base: process.env.GITHUB_ACTIONS ? '/InventoryOS/' : '/',
  plugins: [react(), versionFilePlugin()],
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
