import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts（那是 panel 构建用的，root 指向 src/panel），
// 让 vitest 以插件根为根、发现 tests/ 下的测试。
export default defineConfig({
  test: {
    // .tsx 是面板组件测试（testing-library）；.ts 是服务端与桥的测试。
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
