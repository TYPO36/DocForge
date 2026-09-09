import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/client",
  resolve: { alias: { "@": fileURLToPath(new URL("./src/client", import.meta.url)), "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8788" }
  }
});
