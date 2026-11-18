import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The simulation worker is an ES module worker (`new Worker(url, { type: 'module' })`), in the build as in `npm run dev`.
  worker: { format: 'es' },
  build: {
    // Three.js is one chunk of about 630 kB, loaded on demand with the 3D scene (Phases 4 and 8): the
    // warning is for a chunk that grows past it.
    chunkSizeWarningLimit: 700,
    // The licenses of the libraries the bundle contains, written by the build next to the app and served with it: the
    // libraries' own licenses ask for their notice to travel with every copy. What no package carries is in
    // `public/third-party-notices.txt`.
    license: { fileName: 'third-party-licenses.txt' },
  },
});
