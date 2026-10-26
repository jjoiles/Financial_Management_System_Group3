import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const path = (value: string) => fileURLToPath(new URL(value, import.meta.url));

// Separate entry point only: these fixtures cannot enter the production build.
export default defineConfig({
  root: path(".."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@/lib/auth-context", replacement: path("./auth-fixture.ts") },
      { find: "@/lib/requests/browser-submission", replacement: path("./submission-fixture.ts") },
      { find: "@", replacement: path("../src") },
    ],
  },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
