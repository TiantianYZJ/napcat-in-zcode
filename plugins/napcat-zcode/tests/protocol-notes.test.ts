/**
 * 协议笔记的**引文精度**守卫（M1.1-13）。
 *
 * `src/panel/protocol-notes.md` 是面板桥接层的唯一事实来源：
 * 引文与复核命令一旦与宿主二进制对不上，后人照着它复核会得到错误结论
 * （M1.1 就出现过：§6.2 引的 `Gye` 少了 `decodeURIComponent` 与 try/catch，
 *  §6.3 的 grep 又会先命中同名的另一个定义）。
 *
 * 这里只断言「引文与命令的形状」——二进制本身不在仓库里，
 * 「命令能否命中正确的那处定义」靠命令里的**函数体特征锚点**来保证。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const notes = readFileSync(
  fileURLToPath(new URL('../src/panel/protocol-notes.md', import.meta.url)),
  'utf-8',
);

/** 抽出文件里所有 ```bash 代码块。 */
function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** 抽出某个小节（`### 6.2` 这样的标题到下一个同级/上级标题之间）。 */
function section(text: string, from: string, to: string): string {
  const i = text.indexOf(from);
  const j = text.indexOf(to);
  expect(i, `notes 里找不到小节 ${from}`).toBeGreaterThan(-1);
  expect(j, `notes 里找不到小节 ${to}`).toBeGreaterThan(i);
  return text.slice(i, j);
}

describe('protocol-notes 的引文精度', () => {
  it('§6.2 的 Gye 引文包含 decodeURIComponent 与 try/catch', () => {
    const s = section(notes, '### 6.2', '### 6.3');
    // 这两处正是「uri 最后一段要做 URL 解码、解码失败用原样」的依据，不能省
    expect(s).toContain('decodeURIComponent');
    expect(s).toContain('catch');
  });

  it('§6.3 的复核命令按函数体特征锚定（不会命中同名的另外两个定义）', () => {
    const blocks = bashBlocks(notes);
    const grepsGye = blocks
      .flatMap((b) => b.split('\n'))
      .filter((l) => l.includes('grep') && l.includes('function Gye(e){'));
    expect(grepsGye.length).toBeGreaterThan(0);
    for (const line of grepsGye) {
      // 唯一允许的例外是「列出全部同名定义」的对照命令（带 -b 偏移）
      if (line.includes('-b ')) continue;
      expect(line).toContain('Gye(e){let t=');
    }
  });

  it('§6.3 写清同名定义有多个、正确的是哪一个', () => {
    const s = section(notes, '### 6.3', '## 7.');
    expect(s).toMatch(/3 处|3 次/);
    expect(s).toContain('第 3 个');
    // 无关的那两个也要点名，免得后人再被它们坑一次
    expect(s).toContain('readPositiveInt');
  });
});
