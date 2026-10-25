import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  // The explorer imports the reference payoff from packages/core.
  server: { port: 5191, fs: { allow: ['..'] } },
});
