import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from https://<user>.github.io/vivar/, so asset
// URLs need the /vivar/ prefix there. Everywhere else (dev server, local
// preview, other hosts) the site lives at the root.
const base = process.env.GITHUB_PAGES === 'true' ? '/vivar/' : '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
