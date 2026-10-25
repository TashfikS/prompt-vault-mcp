import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendPort = env.BACKEND_PORT || process.env.BACKEND_PORT || '8002'

  return {
    plugins: [react()],
    base: '/',
    server: {
      proxy: {
        '/api': `http://127.0.0.1:${backendPort}`,
        '/mcp': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true },
      },
    },
    build: {
    outDir: resolve(__dirname, './dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/@modelcontextprotocol/') || id.includes('node_modules/zod/')) {
            return 'mcp-vendor'
          }
          if (id.includes('node_modules/lucide-react/') || id.includes('node_modules/diff/')) {
            return 'ui-vendor'
          }
        },
      },
    },
  },
}
})