import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const spaFallbackPlugin = {
  name: 'generate-spa-fallback',
  closeBundle() {
    const src = path.resolve(process.cwd(), 'dist/index.html');
    const dest = path.resolve(process.cwd(), 'dist/404.html');
    fs.copyFileSync(src, dest);
  },
};

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/TimeLens/' : '/',
  define: {
    __DEPLOY_TARGET__: JSON.stringify(process.env.GITHUB_PAGES ? 'demo' : 'dev'),
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Proxy API requests to WinDbg plugin HTTP server
      '/api': {
        target: 'http://172.16.40.132:8080',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pixi.js')) {
            return 'pixi';
          }
          return undefined;
        }
      }
    }
  },
  plugins: [spaFallbackPlugin],
  optimizeDeps: {
    include: ['pixi.js']
  }
});
