import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // IMPORTANT: Our backend route must win over the generic Sleeper public API proxy.
      // This is the endpoint your ReviewSlip page calls.
      "/api/sleeper/vision-ocr": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/api/vision-ocr": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },

      // Public Sleeper API proxy (kept as-is for your existing calls)
      "/api/sleeper": {
        target: "https://api.sleeper.app",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/sleeper/, "/v1"),
      },

      // Local backend services
      "/api/lines": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/api/odds": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
