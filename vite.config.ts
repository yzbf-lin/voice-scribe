import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The dev server port is configurable so several projects can run side by side
// (this one defaults to 5180; 5173 is usually taken by another app's Vite).
const devPort = Number(process.env.VITE_PORT || 5180);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: { port: devPort, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
