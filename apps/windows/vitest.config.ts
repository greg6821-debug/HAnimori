import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // SFC в тестах: P2-17 гоняет axe по настоящей разметке экрана и модалки,
  // а не по собранному dist. Без плагина vite отказывается компилировать .vue.
  plugins: [vue()],
  resolve: {
    alias: {
      // Общее ядро лежит в packages/core. Алиасы те же по имени, что и были: правки в
      // коде ядра и экранов от переезда не потребовались ни одной.
      '@/api': fileURLToPath(new URL('../../packages/core/src/api', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('../../packages/core/src/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('../../packages/core/src/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('../../packages/core/src/utils', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Заглушка моста живёт с ядром: она проверяет контракт, а не экран. Экранные наборы
      // достают её через этот псевдоним — своей копии у них нет и быть не должно.
      '@core-tests': fileURLToPath(new URL('../../packages/core/tests/mocks', import.meta.url)),
      '@bridge-impl': fileURLToPath(
        new URL('../../packages/core/tests/mocks/bridge.ts', import.meta.url),
      ),
      '@/bridge': fileURLToPath(
        new URL('../../packages/core/tests/mocks/bridge-module.ts', import.meta.url),
      ),
    },
  },
  define: {
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    __ANIMORI_VERSION__: JSON.stringify('test'),
    // Мост в проверках подменён заглушкой, но объявление остаётся: файл моста общий,
    // и ключ читается из него же. Значение — как в настоящей сборке этого продукта.
    __ANIMORI_SHELL_CAN__: JSON.stringify({
      browser: true,
      history: true,
      fullscreen: true,
      cast: true,
      devtools: true,
    }),
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
})
