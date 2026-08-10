import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Anchored with the slash: a bare prefix like "/api" is matched with
      // startsWith and would swallow /api.ts — the web client's own module —
      // and hand it to the backend, whose HTML fallback then breaks the
      // import graph with a MIME error.
      "^/api/": "http://localhost:8788",
      "^/auth/": "http://localhost:8788",
    },
  },
});
