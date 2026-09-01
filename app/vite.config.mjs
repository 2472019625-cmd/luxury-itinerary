import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
    // Windows 下迁移后的历史 dist 在 Vite 自动清空时会触发原生进程异常；
    // 构建文件使用内容哈希覆盖，保留旧文件不影响当前 index.html 引用。
    emptyOutDir: false,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    proxy: {
      "/api": "http://127.0.0.1:4180",
      "/generated": "http://127.0.0.1:4180",
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
