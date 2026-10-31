import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API calls to the Fastify server (default :8730).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8730", "/logos": "http://localhost:8730", "/channel/": "http://localhost:8730", "/session/": "http://localhost:8730" } },
  // emptyOutDir:false — some mounts can't rmdir the old dist; stale hashed
  // assets are harmless since index.html references the new ones.
  build: { outDir: "dist", emptyOutDir: false },
});
