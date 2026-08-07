import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    globals: true,
    css: true,
  },
});
