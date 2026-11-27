import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  // Match the declared macOS 12 WebView baseline.
  build: { target: "safari15" },
  resolve: {
    alias: {
      "@portable/protocol": path.resolve(__dirname, "../../server/packages/protocol/src/index.ts"),
    },
  },
});
