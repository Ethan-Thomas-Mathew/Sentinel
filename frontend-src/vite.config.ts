import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The build writes straight into ../frontend, which is the folder FastAPI
// serves. So `npm run build` is the only step between source and running app,
// and the compiled output is committed — meaning the project runs with no
// Node toolchain installed at all.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../frontend',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // `npm run dev` proxies the API to the Python backend on :8000 so the
    // front end can be developed with hot reload against the real pipeline.
    proxy: {
      '/api': 'http://localhost:8000',
      '/video.mjpg': 'http://localhost:8000',
      '/snapshots': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
