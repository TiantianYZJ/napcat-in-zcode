/**
 * M2 Task 5：`napcat_configure` 的**加法式**扩展（可选参数 `paths`）。
 *
 * 契约（既有调用不受影响）：
 * - 不传 `paths` → 行为与从前**完全一致**（不动 `autoDetect.paths`）；
 * - 传 `paths` → 额外把**绝对路径**写进 `config.json` 的 `autoDetect.paths`；
 * - 相对路径 → **报错**并说明原因（不静默丢弃：假阴性比多候选更糟）；
 * - `endpoint` 留空 + 传 `paths` → 只改扫描路径，不碰连接（用户还没配置端点时也能改路径）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppState } from '../src/server/state.js';
import { registerTools } from '../src/server/tools.js';
import type { OneBotClient } from '../src/server/onebot/client.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-paths-'));
  // 配置目录指向临时目录：绝不碰开发者本机的配置
  process.env.ZCODE_PLUGIN_DATA = tmp;
});

afterEach(() => {
  delete process.env.ZCODE_PLUGIN_DATA;
  rmSync(tmp, { recursive: true, force: true });
});

function stubClient(): OneBotClient {
  return {
    async call<T>(action: string): Promise<T> {
      if (action === 'get_login_info') return { user_id: 1, nickname: 'TestBot' } as unknown as T;
      return null as unknown as T;
    },
    async close() {},
  };
}

async function makeClient(client: OneBotClient = stubClient()): Promise<{ c: Client; state: AppState }> {
  const server = new McpServer({ name: 'napcat', version: '0.1.0' });
  const state = new AppState();
  state.clientOverride = client;
  registerTools(server, state);
  const c = new Client({ name: 'test', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await c.connect(ct);
  return { c, state };
}

function payload(r: unknown): Record<string, any> {
  const content = (r as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content[0]?.text ?? '');
}

function isError(r: unknown): boolean {
  return (r as { isError?: boolean }).isError === true;
}

function diskConfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8'));
}

describe('napcat_configure：可选参数 paths（加法式扩展）', () => {
  it('入参 schema 里 paths 是可选的（既有调用不受影响）', async () => {
    const { c } = await makeClient();
    const list = await c.listTools();
    const schema = list.tools.find((t) => t.name === 'napcat_configure')?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toContain('paths');
    // 既有参数仍是必填/可选的原样
    expect(schema.required ?? []).toContain('endpoint');
    expect(schema.required ?? []).not.toContain('paths');
  });

  it('传绝对路径 → 写进 config.json 的 autoDetect.paths', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', paths: ['D:\\NapCat', 'D:\\QQChatExporter'] },
    });
    expect(isError(r)).toBe(false);
    expect(diskConfig().autoDetect?.paths).toEqual(['D:\\NapCat', 'D:\\QQChatExporter']);
    expect(payload(r).pathsSaved).toBe(true);
  });

  it('不传 paths → autoDetect.paths 不被创建/改动（既有行为不变）', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000' },
    });
    expect(isError(r)).toBe(false);
    expect(diskConfig().autoDetect).toBeUndefined();
    expect(payload(r).pathsSaved).toBeUndefined();
  });

  it('相对路径 → 报错并说清原因（不静默丢弃，也不落盘）', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', paths: ['NapCat'] },
    });
    expect(isError(r)).toBe(true);
    expect(payload(r).error).toContain('绝对路径');
    expect(existsSync(join(tmp, 'config.json'))).toBe(false);
  });

  it('endpoint 留空 + 传 paths → 只改扫描路径，不碰连接', async () => {
    const { c, state } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: '', paths: ['D:\\NapCat'] },
    });
    expect(isError(r)).toBe(false);
    expect(diskConfig().autoDetect?.paths).toEqual(['D:\\NapCat']);
    // 连接没被动过（没端点、没 token）
    expect(diskConfig().connection).toBeUndefined();
    expect(state.config.connection.endpoint).toBe('');
  });

  it('endpoint 留空且不传 paths → 仍然报错（既有语义：空端点不是合法端点）', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({ name: 'napcat_configure', arguments: { endpoint: '' } });
    expect(isError(r)).toBe(true);
    expect(payload(r).error).toContain('端点');
  });

  it('paths 变了 → 探测结论缓存失效（探测范围变了，旧结论不能留）', async () => {
    const { c, state } = await makeClient();
    state.setDetection({ found: true, napcatRunning: true, endpoint: 'http://127.0.0.1:3000' });
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', paths: ['D:\\NapCat'] },
    });
    expect(state.detection).toBeUndefined();
  });

  it('内存态也跟着更新（status 之外的读取也能看到新路径）', async () => {
    const { c, state } = await makeClient();
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', paths: ['D:\\NapCat'] },
    });
    expect(state.config.autoDetect.paths).toEqual(['D:\\NapCat']);
  });

  it('重复路径与空串会被去掉（落盘的是去重后的绝对路径）', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: {
        endpoint: 'http://127.0.0.1:3000',
        paths: ['D:\\NapCat', 'D:\\NapCat', '  ', 'D:\\QQChatExporter'],
      },
    });
    expect(isError(r)).toBe(false);
    expect(diskConfig().autoDetect?.paths).toEqual(['D:\\NapCat', 'D:\\QQChatExporter']);
  });
});
