import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// 경제 엔진은 화면이 없다. 라이브러리 모드로만 빌드한다.
// 화면(작업 D)이 붙으면 그때 일반 앱 빌드로 전환한다.
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('src/engine/index.ts', import.meta.url)),
      name: 'PubEconomy',
      formats: ['es'],
      fileName: 'engine',
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
