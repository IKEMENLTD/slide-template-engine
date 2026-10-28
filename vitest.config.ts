import { defineConfig } from 'vitest/config';

// 通しの試験（PPTX の組み立て・写真の加工）は数秒かかるので、既定の 5 秒では足りない
export default defineConfig({ test: { testTimeout: 120_000 } });
