import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Standalone config (not merged with vite.config.ts) since the test
// runner doesn't need that file's build/dev-server/legacy options.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
  },
});
