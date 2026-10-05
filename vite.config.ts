import { defineConfig } from 'vite';

// The viewer. The simulation runs in a module worker (src/worker/sim-worker.ts).
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
