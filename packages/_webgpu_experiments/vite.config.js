import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  build: {
    // Built outside public/, which is the Vite root: writing the build into the root would make the build
    // an input of the next build.
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'public/index.html'),
        gemma4E2bWebgpuKernels: resolve(import.meta.dirname, 'public/gemma4-e2b-webgpu-kernels/index.html'),
      },
    },
  },
});
