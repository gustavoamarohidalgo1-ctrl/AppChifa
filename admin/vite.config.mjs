import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  envDir: resolve(__dirname, ".."),
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
