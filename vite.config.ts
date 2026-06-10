import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // '/InventoryOS/' for GitHub Pages (repo subpath); change to '/' if using a custom domain
  base: process.env.GITHUB_ACTIONS ? '/InventoryOS/' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
