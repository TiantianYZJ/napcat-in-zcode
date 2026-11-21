/**
 * napcat_adopt：把检测到的本机安装接管进台账（0.8.0）。
 *
 * 布局契约（来自真实安装）：`<root>/QQ.exe` + `<root>/napcat/{NapCatWinBootMain.exe, package.json, config/}`。
 * 接管 = 登记（mode: inject, adopted: true, dir = root）+ 写缺失的 `qq_path.txt`（QCE 惯例）；
 * 之后 napcat_uninstall 对接管条目**只销号、不删目录**（那是用户的文件）。
 */
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { dataDir } from '../src/server/config.js';
import { registerHostTools } from '../src/server/host/host-tools.js';
import type { AppState } from '../src/server/state.js';

const workDirs: string[] = [];

function makeState(): AppState {
  return {
    config: {} as never,
    redact: (t: string) => t,
  } as unknown as AppState;
}

/** 造一个可接管的布局：<root>/QQ.exe + napcat/{NapCatWinBootMain.exe, package.json, config/webui.json} */
function makeInstallLayout(root: string, version = '4.18.42'): string {
  const napcatDir = join(root, 'napcat');
  const configDir = join(napcatDir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(root, 'QQ.exe'), 'qq', 'utf-8');
  writeFileSync(join(napcatDir, 'NapCatWinBootMain.exe'), 'boot', 'utf-8');
  writeFileSync(join(napcatDir, 'package.json'), JSON.stringify({ name: 'napcat', version }), 'utf-8');
  writeFileSync(join(configDir, 'webui.json'), JSON.stringify({ port: 6099 }), 'utf-8');
  return configDir;
}

async function makeClient() {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerHostTools(server, makeState());
  const client = new Client({ name: 'c', version: '0.0.0' });
  const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; data: Record<string, unknown> }> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text };
  }
  return { isError: r.isError === true, data: parsed as Record<string, unknown> };
}

describe('napcat_adopt（接管检测到的本机安装）', () => {
  let workDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'napcat-adopt-'));
    workDirs.push(workDir);
    prevDataDir = process.env.ZCODE_PLUGIN_DATA;
    process.env.ZCODE_PLUGIN_DATA = join(workDir, 'plugin-data');
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.ZCODE_PLUGIN_DATA;
    else process.env.ZCODE_PLUGIN_DATA = prevDataDir;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('接管成功：登记 inject 条目 + 写缺失的 qq_path.txt；host_status 可见', async () => {
    void dataDir; // dataDir() 在工具内部按 env 解析
    const client = await makeClient();
    const configDir = makeInstallLayout(join(workDir, 'napcat-root'));
    const r = await call(client, 'napcat_adopt', { configDir, webuiPort: 6099 });
    expect(r.isError).toBe(false);
    expect(r.data.adopted).toBe(true);
    expect(r.data.qqPathFound).toBe(true);
    const id = r.data.id as string;

    // qq_path.txt 只在缺失时写、内容是 QQ.exe
    const qp = join(configDir, 'qq_path.txt');
    expect(existsSync(qp)).toBe(true);
    expect(readFileSync(qp, 'utf-8')).toBe(join(workDir, 'napcat-root', 'QQ.exe'));

    const hs = await call(client, 'napcat_host_status', {});
    const installs = hs.data.installs as Array<Record<string, unknown>>;
    const mine = installs.find((i) => i.id === id);
    expect(mine).toBeTruthy();
    expect(mine?.adopted).toBe(true);
    expect(mine?.mode).toBe('inject');
    await client.close();
  });

  it('重复接管：幂等（返回已有条目，不重复登记）', async () => {
    const client = await makeClient();
    const configDir = makeInstallLayout(join(workDir, 'dup-root'));
    const first = await call(client, 'napcat_adopt', { configDir });
    const second = await call(client, 'napcat_adopt', { configDir });
    expect(first.data.id).toBe(second.data.id);
    const hs = await call(client, 'napcat_host_status', {});
    const installs = hs.data.installs as unknown[];
    expect(installs.filter((i) => (i as Record<string, unknown>).adopted === true)).toHaveLength(1);
    await client.close();
  });

  it('缺 NapCatWinBootMain.exe / QQ.exe：如实拒绝，不写任何文件', async () => {
    const client = await makeClient();
    // 没有 boot exe
    const bad1 = join(workDir, 'no-boot', 'napcat', 'config');
    mkdirSync(bad1, { recursive: true });
    const r1 = await call(client, 'napcat_adopt', { configDir: bad1 });
    expect(r1.isError).toBe(true);
    expect(String(r1.data.error)).toContain('NapCatWinBootMain.exe');
    // 有 boot 没 QQ.exe：仍接管（启动前需配 desktop QQ 路径），但不写 qq_path.txt
    const root2 = join(workDir, 'no-qq');
    const napcat2 = join(root2, 'napcat');
    mkdirSync(join(napcat2, 'config'), { recursive: true });
    writeFileSync(join(napcat2, 'NapCatWinBootMain.exe'), 'boot', 'utf-8');
    const r2 = await call(client, 'napcat_adopt', { configDir: join(napcat2, 'config') });
    expect(r2.isError).toBe(false);
    expect(r2.data.qqPathFound).toBe(false);
    expect(existsSync(join(napcat2, 'config', 'qq_path.txt'))).toBe(false);
    await client.close();
  });

  it('接管条目的卸载只销号、保留目录', async () => {
    const client = await makeClient();
    const root = join(workDir, 'keep-root');
    const configDir = makeInstallLayout(root);
    const adopted = await call(client, 'napcat_adopt', { configDir });
    const id = adopted.data.id as string;
    await call(client, 'napcat_stop', { id }); // 确保 pid 语义干净（未启动也无妨）
    const r = await call(client, 'napcat_uninstall', { id });
    expect(r.isError).toBe(false);
    expect(r.data.kept).toBe(true);
    // 目录原样保留
    expect(existsSync(join(root, 'QQ.exe'))).toBe(true);
    expect(existsSync(join(root, 'napcat', 'NapCatWinBootMain.exe'))).toBe(true);
    const hs = await call(client, 'napcat_host_status', {});
    const installs = hs.data.installs as unknown[];
    expect(installs.filter((i) => (i as Record<string, unknown>).id === id)).toHaveLength(0);
    await client.close();
  });
});
