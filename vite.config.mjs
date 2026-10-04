import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig(() => {
  const productRoot = fileURLToPath(new URL(".", import.meta.url));
  const output = path.resolve(process.env.TUYUWEB_DIST || path.join(tmpdir(), "tuyuweb", "dist"));
  if (output === productRoot || output.startsWith(productRoot + path.sep)) {
    throw new Error("TUYUWEB_DIST必须是TuyuWeb源码外的绝对路径");
  }
  return {
  build: {
    outDir: `${output}/client`,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
  };
});
