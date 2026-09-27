import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      viteStaticCopy({
        targets: [
          {
            src: 'src/main/prompts.md',
            dest: '.'
          },
          {
            src: 'src/main/prompts-voice.md',
            dest: '.'
          },
          ...(process.platform === 'darwin'
            ? [
                {
                  src: 'resources/bin/capture-below',
                  dest: 'bin'
                },
                {
                  src: 'resources/bin/audio-tap',
                  dest: 'bin'
                }
              ]
            : [])
        ]
      })
    ]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
