/**
 * 清单契约（最终修复波 MF-3）。
 *
 * 插件有**两份** MCP server 声明：`.mcp.json` 与 `.zcode-plugin/plugin.json`。
 * ZCode 读哪一份、两者同时存在时谁优先，没有公开契约（本机官方插件两种形态都有：
 * `android-emulator` 两份都写、`jev-decisions` 只写 `.mcp.json`、`documents` 只写
 * `plugin.json`）。一旦两份不一致，**失败是静默的**：
 * 之前 `plugin.json` 的 `mcpServers` 少了 `env` 块 → 设置界面里的「导出目录」
 * 根本不生效（env 不注入 → config.json 保持权威），用户看不出来。
 *
 * 因此本文件把两份清单锁成**同源**，并守住可移植性硬约束（spec §7）：
 * - `command` 必须是 `node`（不是 `ZCode.exe` 绝对路径）；
 * - 只允许四类令牌：`${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` /
 *   `${ZCODE_PROJECT_DIR}` / `${user_config.*}`；
 * - `userConfig` 的 `default` 必须为空串（空串不是合法值 → 不覆盖 config.json）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

const mcpPath = fileURLToPath(new URL('../.mcp.json', import.meta.url));
const pluginPath = fileURLToPath(new URL('../.zcode-plugin/plugin.json', import.meta.url));

const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
  mcpServers: Record<string, ServerSpec>;
};
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8')) as {
  name: string;
  version: string;
  userConfig?: Record<string, { title?: string; description?: string; type?: string; default?: unknown }>;
  mcpServers: Record<string, ServerSpec>;
  ui?: {
    surfaces?: Array<{
      id: string;
      server: string;
      resourceUri: string;
      availability?: string;
      title?: Record<string, string>;
      icon?: string;
    }>;
  };
};

/** spec §7 允许的令牌（`${user_config.*}` 由 userConfig 单独校验）。 */
const ALLOWED_TOKENS = new Set([
  '${ZCODE_PLUGIN_ROOT}',
  '${ZCODE_PLUGIN_DATA}',
  '${ZCODE_PROJECT_DIR}',
]);

/** 收集一个值里出现的所有 `${...}` 令牌。 */
function tokensIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\$\{[^}]*\}/g)) out.push(m[0]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return out;
}

describe('清单契约：两份 MCP server 声明同源', () => {
  it('两份清单都声明了名为 napcat 的 server', () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(['napcat']);
    expect(Object.keys(plugin.mcpServers)).toEqual(['napcat']);
  });

  it('command 必须是 node（可移植性硬约束：不能写 ZCode.exe 绝对路径）', () => {
    expect(mcp.mcpServers.napcat.command).toBe('node');
    expect(plugin.mcpServers.napcat.command).toBe('node');
    // args 里也不许出现机器特定路径
    for (const args of [mcp.mcpServers.napcat.args ?? [], plugin.mcpServers.napcat.args ?? []]) {
      for (const a of args) {
        expect(a).not.toMatch(/[A-Za-z]:[\\/]/); // 没有盘符绝对路径
        expect(a).not.toContain('ZCode.exe');
        expect(a).not.toContain('zcode.cjs');
      }
    }
  });

  it('两份清单的 args / timeoutMs / cwd 一致', () => {
    expect(plugin.mcpServers.napcat.args).toEqual(mcp.mcpServers.napcat.args);
    expect(plugin.mcpServers.napcat.timeoutMs).toBe(mcp.mcpServers.napcat.timeoutMs);
    expect(plugin.mcpServers.napcat.cwd).toBe(mcp.mcpServers.napcat.cwd);
  });

  it('两份清单的 env 键集一致（否则设置界面会静默失效）', () => {
    expect(Object.keys(plugin.mcpServers.napcat.env ?? {}).sort()).toEqual(
      Object.keys(mcp.mcpServers.napcat.env ?? {}).sort(),
    );
  });

  it('清单版本与包版本保持同步', () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
    ) as { version: string };
    const marketplace = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../marketplace.json', import.meta.url)), 'utf-8'),
    ) as { plugins: Array<{ name: string; version: string }> };
    expect(plugin.version).toBe('0.11.0');
    expect(packageJson.version).toBe(plugin.version);
    expect(marketplace.plugins.find((item) => item.name === plugin.name)?.version).toBe(plugin.version);
  });

  it('env 声明了用户配置项的完整接线', () => {
    const env = plugin.mcpServers.napcat.env ?? {};
    expect(env.NAPCAT_EXPORT_DIR).toBe('${user_config.exportDir}');
    expect(env.NAPCAT_INCLUDE_IMAGES).toBe('${user_config.includeImages}');
    expect(env.NAPCAT_DOWNLOAD_PROXY).toBe('${user_config.downloadProxy}');
    expect(env.NAPCAT_DESKTOP_QQ_PATH).toBe('${user_config.desktopQqPath}');
  });

  it('env 显式声明了插件数据目录与工作区目录（服务端靠它们定位数据/工作区）', () => {
    const env = plugin.mcpServers.napcat.env ?? {};
    expect(env.ZCODE_PLUGIN_DATA).toBe('${ZCODE_PLUGIN_DATA}');
    expect(env.ZCODE_PROJECT_DIR).toBe('${ZCODE_PROJECT_DIR}');
    const mcpEnv = mcp.mcpServers.napcat.env ?? {};
    expect(mcpEnv.ZCODE_PLUGIN_DATA).toBe('${ZCODE_PLUGIN_DATA}');
    expect(mcpEnv.ZCODE_PROJECT_DIR).toBe('${ZCODE_PROJECT_DIR}');
  });

  it('只用 spec §7 允许的令牌', () => {
    const tokens = [
      ...tokensIn(mcp.mcpServers.napcat),
      ...tokensIn(plugin.mcpServers.napcat),
    ];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      if (t.startsWith('${user_config.')) {
        expect(t).toMatch(/^\$\{user_config\.[A-Za-z0-9_]+\}$/);
        continue;
      }
      expect(ALLOWED_TOKENS.has(t)).toBe(true);
    }
  });
});

describe('清单契约：userConfig', () => {
  it('两项设置的 type 是 string、default 是空串（空串非法 → 不覆盖 config.json）', () => {
    const uc = plugin.userConfig ?? {};
    expect(Object.keys(uc).sort()).toEqual(['desktopQqPath', 'downloadProxy', 'exportDir', 'includeImages']);
    for (const key of Object.keys(uc)) {
      expect(uc[key].type).toBe('string');
      expect(uc[key].default).toBe('');
      expect(typeof uc[key].description).toBe('string');
    }
  });
});

describe('清单契约：ui.surfaces', () => {
  it('面板资源 URI 与服务端注册的一致', () => {
    const surface = plugin.ui?.surfaces?.[0];
    expect(surface?.resourceUri).toBe('ui://napcat-zcode/panel.html');
    expect(surface?.server).toBe('napcat');
    expect(surface?.id).toBe('napcat-zcode');
    expect(surface?.availability).toBe('session');
  });
});
