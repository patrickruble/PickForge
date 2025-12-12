import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/sleeper": {
        target: "https://api.sleeper.app",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/sleeper/, "/v1"),
      },
      "/api/lines": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
