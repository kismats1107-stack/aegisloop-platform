import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5180, strictPort: true, watch: { usePolling: true, interval: 300 }, proxy: { "/api/nx": "http://127.0.0.1:8787", "/api/live": { target: "http://127.0.0.1:8790", ws: true }, "/api": "http://127.0.0.1:8000", "/ws": { target: "ws://127.0.0.1:8000", ws: true } } },
  build: { chunkSizeWarningLimit: 1500 },
});
