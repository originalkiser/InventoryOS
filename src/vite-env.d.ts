/// <reference types="vite/client" />

// Injected at build time by vite.config.ts (define). The git sha in CI, else a
// timestamp. The running app compares this against dist/version.json to detect
// a newer deploy.
declare const __APP_BUILD_ID__: string
