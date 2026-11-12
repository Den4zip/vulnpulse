import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts'),
          'fstec-import': resolve(__dirname, 'src/main/services/feeds/fstec-runtime.ts') },
        preserveEntrySignatures: 'strict'
      }
    },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    // Use the same loopback address in Vite and Electron; localhost may resolve to different IP families.
    server: { host: '127.0.0.1' },
    plugins: [react(), tailwindcss(), {
      name: 'vulnpulse-csp',
      transformIndexHtml(html, context) {
        const development = !!context.server
        const policy = [
          "default-src 'self'",
          development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
          "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
          development ? "connect-src 'self' ws://localhost:* ws://127.0.0.1:*" : "connect-src 'none'",
          "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"
        ].join('; ')
        return html.replace('__VULNPULSE_CSP__', policy)
      }
    }],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
