import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import base from './vite.config.mjs';

// Only build the standalone preview. Keep the normal app bundle intact on 4174.
export default defineConfig({
  ...base,
  build: {
    ...base.build,
    rollupOptions: { input: resolve(import.meta.dirname, 'hotel-fact-preview.html') },
  },
});
