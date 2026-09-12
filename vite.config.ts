/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
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

// Neither GitHub Pages nor Cloudflare Pages does server-side SPA routing —
// a deep link (e.g. /menu-board/4-a3f9) 404s unless the host falls back to
// serving the app shell, which lets React Router take over from there.
// Cloudflare's public/_redirects handles this with a 200, but a host that
// falls back to a literal 404.html file (as Cloudflare's static-asset layer
// does for a genuinely-missing path, and as GitHub Pages always does) needs
// that file to actually BE the app, not a placeholder — otherwise it can't
// render anything at all. This used to be handled by a hand-maintained
// public/404.html with a GitHub-Pages-specific query-string encode/decode
// trick that assumed the site always lived under a /RepoName/ subpath; that
// assumption broke catastrophically once the app moved to a root domain
// (sboc.app) — each re-serve of 404.html re-encoded the already-encoded
// query string, producing a runaway ?/&/~and~/~and~/~and~/... URL that never
// resolved. Generating dist/404.html here — as an exact copy of the real
// built dist/index.html, for every build, on every host — replaces that
// trick entirely: no encoding, just the real app shell, so whatever path
// the browser actually has stays intact for React Router to match normally.
function spa404Plugin() {
  return {
    name: 'write-spa-404',
    closeBundle() {
      try {
        const html = readFileSync(path.resolve(__dirname, 'dist/index.html'), 'utf-8')
        writeFileSync(path.resolve(__dirname, 'dist/404.html'), html)
      } catch { /* ignore (e.g. non-build runs) */ }
    },
  }
}

export default defineConfig({
  // '/InventoryOS/' for GitHub Pages (repo subpath); change to '/' if using a custom domain
  base: process.env.GITHUB_ACTIONS ? '/InventoryOS/' : '/',
  plugins: [react(), versionFilePlugin(), spa404Plugin()],
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
