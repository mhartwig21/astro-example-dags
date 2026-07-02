import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: ".",
  server: { port: 5173, open: false },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"), // 2D top-down slice
        iso: resolve(__dirname, "iso.html"), // 3D isometric view
      },
    },
  },
});
