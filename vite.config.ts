import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 함수형 매칭 — node_modules 경로로 잡아 react-dom/client 같은 서브경로 진입점과
        // scheduler까지 한 청크로 모은다(객체형은 'react-dom' 메인 진입점만 잡아 렌더러
        // ~140kB를 엔트리에 남겼다). 매칭 안 되는 모듈은 undefined → 기본 청킹 유지라
        // Monaco·react-markdown 등 동적 import 전용 의존성을 정적 청크로 끌어오지 않는다.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return "react";
          if (id.includes("@tanstack")) return "query";
          if (id.includes("@xterm")) return "xterm";
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 39090,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
