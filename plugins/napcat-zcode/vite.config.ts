import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// plugin.json 的 resourceUri 固定为 ui://napcat-zcode/panel.html，
// 因此在构建结束后把 Vite 默认输出的 index.html 重命名为 panel.html。
function renamePanelHtml(): Plugin {
  return {
    name: 'rename-panel-html',
    closeBundle() {
      const outDir = fileURLToPath(new URL('./dist/ui', import.meta.url));
      renameSync(`${outDir}/index.html`, `${outDir}/panel.html`);
    },
  };
}

export default defineConfig({
  root: 'src/panel',
  plugins: [react(), viteSingleFile(), renamePanelHtml()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
});
