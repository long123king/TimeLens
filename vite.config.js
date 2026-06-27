import { defineConfig } from 'vite';

export default defineConfig({
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
  optimizeDeps: {
    include: ['pixi.js']
  }
});
