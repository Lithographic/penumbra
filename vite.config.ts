import { defineConfig } from 'vite';

// Deployed at https://<user>.github.io/penumbra/, so asset URLs need the repo-name base.
// Set PAGES=1 when building for Pages; `npm run dev` and local builds stay at the root.
export default defineConfig({
  base: process.env.PAGES ? '/penumbra/' : '/',
});
