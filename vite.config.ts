import { defineConfig } from 'vite';

// Deployed at https://<user>.github.io/penumbra/, so assets need the repo-name base when
// building for Pages. `npm run dev` and local builds are unaffected.
export default defineConfig({
  base: process.env.PAGES ? '/penumbra/' : '/',
});
