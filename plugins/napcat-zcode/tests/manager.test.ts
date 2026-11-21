/**
 * M3 Task 2：受管安装台账 + 安装作业。
 *
 * **全程不联网、不碰真实 NapCat**：假源站用 `node:http` 在 127.0.0.1 上现起（端口取 0），
 * 制品是**在内存里现造的最小 zip**（布局照抄官方新布局：顶层运行文件 + `napcat/` 子目录）。
 *
 * 覆盖五组：
 * ① **台账**：读写往返、`add` 幂等、同目录只有一条、`remove` 后重新读盘仍无；
 * ② **原子写**：写到一半失败不产生半截 JSON（旧文件仍可解析、无残留临时文件）；
 * ③ **端到端安装**：下载 → 校验 → 解压 → 写配置 → 换位 → 落台账；
 * ④ **失败不留半成品**：sha256 不符 / 下载中途断开 / 压缩包损坏 → 目录被清干净；
 * ⑤ **配置与凭据**：`webui.json` / `onebot11_<uin>.json` / 注入模式的 `qqnt.json`；
 *    token 只落两个文件，对外一律掩码。
 *
 * 关于 `downloadVerifiedForTest`：
 * 产品路径 `downloadVerified` **必须**拒绝回环地址（出网红线），而假源站只能跑在回环上。
 * 测试入口只放宽**一个方向**（只允许回环），产品代码不得使用它。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadVerifiedForTest } from '../src/server/host/download.js';
import {
  deriveInstallId,
  findDesktopQqPackage,
  ManagedHost,
  assertInstallTargetSafe,
  maskSecret,
  newJobId,
  scrubLocalPaths,
  writeJsonAtomic,
  type InstallJob,
  type InstallRequest,
  type ManagedHostOptions,
  type ManagedInstall,
} from '../src/server/host/manager.js';

// ── 造 ZIP 的小工具（与 unzip.test.ts 同款，但不跨测试文件 import） ─────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface BuildEntry {
  name: string;
  data: Buffer;
  /** 0 = stored，8 = deflate。 */
  method?: number;
}

/** 造一个最小但合法的 ZIP（本地头 + 中央目录 + EOCD）。 */
function buildZip(entries: BuildEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.method ?? 0;
    const payload = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** 制品自带的 `napcat/qqnt.json`（用于断言「找不到桌面 QQ 时原样保留」）。 */
const ARTIFACT_QQNT = { name: 'qq', version: '9.9.31-49738', buildVersion: '49738', main: './index.js' };

/** 造一个「官方新布局」的最小制品：顶层运行文件 + `napcat/` 子目录。 */
function buildArtifactZip(): Buffer {
  return buildZip([
    { name: 'index.js', data: Buffer.from('require("./napcat/napcat.mjs")\n'), method: 8 },
    { name: 'napcat.bat', data: Buffer.from('@echo off\nnode.exe index.js\n') },
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'napcat-shell', version: '4.18.42' })) },
    { name: 'config.json', data: Buffer.from('{}\n') },
    { name: 'napcat/napcat.mjs', data: Buffer.from('export default 1\n'), method: 8 },
    { name: 'napcat/loadNapCat.js', data: Buffer.from('module.exports = 1\n') },
    { name: 'napcat/qqnt.json', data: Buffer.from(JSON.stringify(ARTIFACT_QQNT)) },
    { name: 'napcat/launcher-user.bat', data: Buffer.from('@echo off\n') },
    { name: 'napcat/static/app.js', data: Buffer.from('console.log("napcat")\n'), method: 8 },
    { name: 'napcat/native/hook.dll', data: Buffer.from('MZ fake dll') },
  ]);
}

// ── 假源站 ──────────────────────────────────────────────────────────

interface FakeServer {
  port: number;
  close(): Promise<void>;
}

type ServeMode =
  /** 正常返回，带 Content-Length。 */
  | 'ok'
  /** 正常返回，但**不给** Content-Length（总大小未知 → percent 必须是 undefined）。 */
  | 'no-length'
  /** 声明 Content-Length 后中途断开连接。 */
  | 'truncated'
  /** 直接返回 500。 */
  | 'error';

async function startServer(body: Buffer, mode: ServeMode = 'ok'): Promise<FakeServer> {
  const server = createHttpServer((_req, res: ServerResponse) => {
    if (mode === 'error') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (mode === 'no-length') {
      res.writeHead(200);
      res.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
      res.end(body.subarray(Math.max(1, Math.floor(body.length / 2))));
      return;
    }
    if (mode === 'truncated') {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      // 提前断开：客户端收到的字节数与声明的不一致
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ── 测试夹具 ────────────────────────────────────────────────────────

function makeJob(): InstallJob {
  return {
    id: newJobId(),
    startedAt: new Date().toISOString(),
    state: 'running',
    phase: 'connecting',
    bytesReceived: 0,
  };
}

function makeInstall(dir: string, overrides: Partial<ManagedInstall> = {}): ManagedInstall {
  return {
    id: deriveInstallId('4.18.42', dir),
    dir,
    version: '4.18.42',
    mode: 'standalone',
    installedAt: new Date().toISOString(),
    artifactSha256: 'a'.repeat(64),
    ...overrides,
  };
}

/** 装一次并等作业结束。 */
async function runInstall(
  host: ManagedHost,
  req: InstallRequest,
): Promise<InstallJob> {
  const job = makeJob();
  host.startInstall(job, req);
  // 作业是异步推进的：轮询到终态为止
  for (let i = 0; i < 600; i++) {
    const current = host.getJob(job.id);
    if (current && current.state !== 'running') return current;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('安装作业超时未结束');
}

describe('M3 Task 2：受管安装台账 + 安装作业', () => {
  let workDir: string;
  let dataDir: string;
  const servers: FakeServer[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'napcat-manager-'));
    dataDir = join(workDir, 'plugin-data');
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  const track = async (server: FakeServer): Promise<FakeServer> => {
    servers.push(server);
    return server;
  };

  const newHost = (opts: Partial<ManagedHostOptions> = {}): ManagedHost =>
    new ManagedHost({
      dataDir,
      platform: 'win32',
      download: downloadVerifiedForTest,
      ...opts,
    });

  describe('安装目标保护', () => {
    it('allows a missing target and an existing empty directory', () => {
      const missing = join(workDir, 'missing');
      const empty = join(workDir, 'empty');
      mkdirSync(empty);
      expect(() => assertInstallTargetSafe(missing, false)).not.toThrow();
      expect(() => assertInstallTargetSafe(empty, false)).not.toThrow();
    });

    it('rejects files, symbolic links, and non-empty unmanaged directories', () => {
      const file = join(workDir, 'user-file');
      const link = join(workDir, 'link');
      const populated = join(workDir, 'populated');
      writeFileSync(file, 'keep');
      mkdirSync(populated);
      writeFileSync(join(populated, 'keep.txt'), 'keep');
      try {
        symlinkSync(file, link);
        expect(() => assertInstallTargetSafe(link, false)).toThrow(/符号链接/);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      }
      expect(() => assertInstallTargetSafe(file, false)).toThrow(/不是目录/);
      expect(() => assertInstallTargetSafe(populated, false)).toThrow(/空目录/);
      expect(readFileSync(file, 'utf8')).toBe('keep');
      expect(readFileSync(join(populated, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('allows a non-empty managed directory to be upgraded', () => {
      const managed = join(workDir, 'managed');
      mkdirSync(managed);
      writeFileSync(join(managed, 'old.txt'), 'managed');
      expect(() => assertInstallTargetSafe(managed, true)).not.toThrow();
    });
  });

  // ── ① 台账 ──────────────────────────────────────────────────────

  describe('台账', () => {
    it('读写往返：重新构造的宿主读到同一条', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      host.add(makeInstall(dir));

      const reopened = newHost();
      expect(reopened.list()).toHaveLength(1);
      expect(reopened.list()[0]).toMatchObject({
        dir,
        version: '4.18.42',
        mode: 'standalone',
        artifactSha256: 'a'.repeat(64),
      });
      expect(reopened.get(reopened.list()[0].id)?.dir).toBe(dir);
    });

    it('add 同 id 幂等：不产生第二条', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      const install = makeInstall(dir);
      host.add(install);
      host.add({ ...install });
      host.add({ ...install, installedAt: new Date().toISOString() });
      expect(host.list()).toHaveLength(1);
    });

    it('同一目录换版本重装：台账里仍然只有一条', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat');
      host.add(makeInstall(dir, { version: '4.18.42' }));
      host.add(
        makeInstall(dir, {
          version: '4.19.0',
          id: deriveInstallId('4.19.0', dir),
          artifactSha256: 'b'.repeat(64),
        }),
      );
      expect(host.list()).toHaveLength(1);
      expect(host.list()[0].version).toBe('4.19.0');
    });

    it('remove 之后重新读盘仍然没有这一条', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      const install = makeInstall(dir);
      host.add(install);
      expect(host.remove(install.id)).toBe(true);
      expect(host.remove(install.id)).toBe(false);

      const reopened = newHost();
      expect(reopened.list()).toHaveLength(0);
    });

    it('id 由版本 + 目录派生：同目录同版本恒等，换目录/换版本即不同', () => {
      const a = deriveInstallId('4.18.42', join(workDir, 'x'));
      const b = deriveInstallId('4.18.42', join(workDir, 'x'));
      const c = deriveInstallId('4.18.42', join(workDir, 'y'));
      const d = deriveInstallId('4.19.0', join(workDir, 'x'));
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).not.toBe(d);
      expect(a.startsWith('napcat-4.18.42-')).toBe(true);
    });

    it('台账里不出现任何凭据（只有安装目录、版本、模式、校验值、pid）', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      host.add(makeInstall(dir));
      const raw = readFileSync(host.registryPath, 'utf-8');
      const parsed = JSON.parse(raw) as { installs: Record<string, unknown>[] };
      expect(Object.keys(parsed.installs[0]).sort()).toEqual(
        ['artifactSha256', 'dir', 'id', 'installedAt', 'mode', 'version'].sort(),
      );
      expect(raw).not.toMatch(/token/i);
    });

    it('台账文件被手改成非法 JSON 时不会把插件带崩（当作空台账）', () => {
      const host = newHost();
      host.add(makeInstall(join(workDir, 'napcat')));
      writeFileSync(host.registryPath, '{ 这不是 JSON', 'utf-8');

      const reopened = newHost();
      expect(reopened.list()).toHaveLength(0);
    });
  });

  // ── ⑥ 卸载（Task 4：删目录 + 销号 + 清凭据） ─────────────────────

  describe('卸载（Task 4）', () => {
    it('删除目录 + 销号 + 清凭据；重开台账为空', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'webui.json'), '{"token":"secret"}', 'utf-8');
      const install = makeInstall(dir);
      host.add(install);

      const r = host.uninstall(install.id);
      expect(r).toMatchObject({ id: install.id, dir, alreadyGone: false });
      expect(existsSync(dir)).toBe(false);
      expect(host.list()).toHaveLength(0);

      const reopened = newHost();
      expect(reopened.list()).toHaveLength(0);
    });

    it('运行中的实例拒绝卸载，目录原样保留', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-running');
      mkdirSync(dir, { recursive: true });
      const install = makeInstall(dir);
      host.add(install);
      host.setPid(install.id, 4321);

      expect(() => host.uninstall(install.id)).toThrow(/先停止/);
      expect(existsSync(dir)).toBe(true);
      expect(host.list()).toHaveLength(1);
    });

    it('目录已不存在：幂等清理（alreadyGone），台账销号', () => {
      const host = newHost();
      const install = makeInstall(join(workDir, 'gone'));
      host.add(install);

      const r = host.uninstall(install.id);
      expect(r.alreadyGone).toBe(true);
      expect(host.list()).toHaveLength(0);
    });

    it('未知 id 报错', () => {
      const host = newHost();
      expect(() => host.uninstall('nope')).toThrow(/台账里没有/);
    });

    it('目录被换成符号链接时拒绝跟随，链接目标不受影响', () => {
      const host = newHost();
      const dir = join(workDir, 'linked');
      const target = join(workDir, 'target');
      mkdirSync(target, { recursive: true });
      let made = true;
      try {
        symlinkSync(target, dir, 'dir');
      } catch {
        made = false; // 无特权环境建不了目录链接 → 跳过该断言
      }
      if (!made) return;
      const install = makeInstall(dir);
      host.add(install);

      expect(() => host.uninstall(install.id)).toThrow(/符号链接/);
      expect(existsSync(target)).toBe(true);
    });

    it('有指向同目录的进行中安装作业时拒绝卸载', () => {
      const dir = join(workDir, 'napcat-busy');
      mkdirSync(dir, { recursive: true });
      // 挂一个永不完成的下载：作业保持 running（stub 永不 resolve，不产生写盘）
      const host = newHost({ download: () => new Promise(() => {}) });
      const install = makeInstall(dir);
      host.add(install);
      const job = makeJob();
      host.startInstall(job, {
        dir,
        version: '4.18.42',
        mode: 'standalone',
        url: 'http://127.0.0.1:9/x.zip',
        sha256: 'a'.repeat(64),
        allowedHosts: ['127.0.0.1'],
      });
      expect(host.listJobs().some((j) => j.state === 'running')).toBe(true);
      expect(() => host.uninstall(install.id)).toThrow(/安装作业/);
    });
  });

  // ── ② 原子写 ────────────────────────────────────────────────────

  describe('原子写', () => {
    it('写到一半失败：不产生半截 JSON，旧文件仍可解析，且不留临时文件', () => {
      const healthy = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      healthy.add(makeInstall(dir));
      const before = readFileSync(healthy.registryPath, 'utf-8');

      const broken = newHost({
        writeJson: (path, value) => {
          if (!path.endsWith('managed-hosts.json')) {
            writeJsonAtomic(path, value);
            return;
          }
          writeJsonAtomic(path, value, {
            writeTmp: (tmpPath, payload) => {
              // 只写一半就「崩了」
              writeFileSync(tmpPath, payload.slice(0, 12), 'utf-8');
              throw new Error('模拟写入中断');
            },
          });
        },
      });

      expect(() => broken.add(makeInstall(join(workDir, 'another')))).toThrow(/模拟写入中断/);

      // 旧文件完好无损
      expect(readFileSync(broken.registryPath, 'utf-8')).toBe(before);
      expect(() => JSON.parse(readFileSync(broken.registryPath, 'utf-8'))).not.toThrow();
      // 内存态没被改坏：仍是上次成功落盘的那一条（失败的那条没进去）
      expect(broken.list()).toHaveLength(1);
      expect(broken.list()[0].dir).toBe(dir);
      // 没有残留的临时文件
      const leftovers = readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('正常写盘不留下临时文件；残留的 .tmp 不影响读取', () => {
      const host = newHost();
      host.add(makeInstall(join(workDir, 'napcat-4.18.42')));
      expect(readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

      // 模拟上一次崩溃留下的半截临时文件
      writeFileSync(join(dataDir, 'managed-hosts.json.123.456.tmp'), '{"inst', 'utf-8');
      const reopened = newHost();
      expect(reopened.list()).toHaveLength(1);
    });
  });

  // ── ③ 端到端安装 ────────────────────────────────────────────────

  describe('端到端安装', () => {
    it('下载 → 校验 → 解压 → 写配置 → 换位 → 落台账', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');

      const job = await runInstall(host, {
        dir: target,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/NapCat.Shell.Windows.Node.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
        uin: '12345678',
      });

      expect(job.state).toBe('succeeded');
      expect(job.phase).toBe('done');
      expect(job.error).toBeUndefined();
      expect(job.bytesReceived).toBe(zip.length);
      expect(job.totalBytes).toBe(zip.length);
      expect(job.percent).toBe(100);

      // 目录布局：顶层运行文件 + napcat/ 子目录（整包解开，不自造布局）
      expect(existsSync(join(target, 'index.js'))).toBe(true);
      expect(existsSync(join(target, 'napcat.bat'))).toBe(true);
      expect(existsSync(join(target, 'package.json'))).toBe(true);
      expect(existsSync(join(target, 'napcat', 'napcat.mjs'))).toBe(true);
      expect(existsSync(join(target, 'napcat', 'loadNapCat.js'))).toBe(true);
      expect(existsSync(join(target, 'napcat', 'qqnt.json'))).toBe(true);
      expect(existsSync(join(target, 'napcat', 'launcher-user.bat'))).toBe(true);
      expect(existsSync(join(target, 'napcat', 'native', 'hook.dll'))).toBe(true);
      expect(existsSync(join(target, 'napcat', 'static', 'app.js'))).toBe(true);

      // WebUI 配置：回环 + 6099 + 插件生成的 token
      const webui = JSON.parse(readFileSync(join(target, 'napcat', 'config', 'webui.json'), 'utf-8'));
      expect(webui.host).toBe('127.0.0.1');
      expect(webui.port).toBe(6099);
      expect(typeof webui.token).toBe('string');
      expect(webui.token.length).toBeGreaterThan(16);

      // OneBot 配置：httpServers[0] = 127.0.0.1:3000，无 token
      const onebot = JSON.parse(
        readFileSync(join(target, 'napcat', 'config', 'onebot11_12345678.json'), 'utf-8'),
      );
      expect(onebot.network.httpServers[0]).toMatchObject({ host: '127.0.0.1', port: 3000 });
      expect(JSON.stringify(onebot)).not.toMatch(/token/i);

      // 台账
      expect(host.list()).toHaveLength(1);
      expect(host.list()[0]).toMatchObject({ dir: target, version: '4.18.42', mode: 'standalone' });
      expect(host.list()[0].artifactSha256).toBe(sha);

      // token 只落两处：安装目录的 webui.json 与插件数据目录的私有文件
      expect(host.webuiTokenOf(target)).toBe(webui.token);
      const secretsRaw = readFileSync(host.secretsPath, 'utf-8');
      expect(secretsRaw).toContain(webui.token);
      // 台账里没有它
      expect(readFileSync(host.registryPath, 'utf-8')).not.toContain(webui.token);
      // 对外只有掩码
      const masked = host.maskWebuiToken(target);
      expect(masked).toBeDefined();
      expect(masked).not.toBe(webui.token);
      expect(masked?.includes(webui.token)).toBe(false);
    });

    it('进度反映真实字节数；总大小未知时 percent 是 undefined（不伪造）', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip, 'no-length'));
      const host = newHost();
      const seen: (number | undefined)[] = [];

      const job = makeJob();
      const target = join(workDir, 'install', 'napcat');
      host.startInstall(job, {
        dir: target,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
      });
      for (let i = 0; i < 600; i++) {
        const current = host.getJob(job.id);
        if (current) {
          if (current.state !== 'running') break;
          seen.push(current.percent);
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      const finished = host.getJob(job.id);
      expect(finished?.state).toBe('succeeded');
      // 下载过程中拿到的百分比不得是伪造的 0 / 100
      expect(seen.every((p) => p === undefined)).toBe(true);
      expect(finished?.totalBytes).toBeUndefined();
      expect(finished?.bytesReceived).toBe(zip.length);
    });

    it('重复安装同一目录：台账仍只有一条，目录被替换成新的一份', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');
      const request: InstallRequest = {
        dir: target,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
      };

      const first = await runInstall(host, request);
      expect(first.state).toBe('succeeded');
      const firstId = host.list()[0].id;

      const second = await runInstall(host, request);
      expect(second.state).toBe('succeeded');
      expect(host.list()).toHaveLength(1);
      expect(host.list()[0].id).toBe(firstId);
      // 没有残留的暂存目录 / 备份目录
      const siblings = readdirSync(join(workDir, 'install'));
      expect(siblings.filter((f) => f.includes('napcat-install-'))).toEqual([]);
      expect(siblings.filter((f) => f.includes('napcat-old-'))).toEqual([]);
    });
  });

  // ── ④ 失败不留半成品 ────────────────────────────────────────────

  describe('失败清理', () => {
    const requestFor = (server: FakeServer, sha: string, target: string): InstallRequest => ({
      dir: target,
      version: '4.18.42',
      mode: 'standalone',
      url: `http://127.0.0.1:${server.port}/artifact.zip`,
      sha256: sha,
      allowedHosts: ['127.0.0.1'],
    });

    it('sha256 不符：作业失败、中文原因、目标目录不存在、无残留', async () => {
      const zip = buildArtifactZip();
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');

      const job = await runInstall(host, requestFor(server, 'c'.repeat(64), target));

      expect(job.state).toBe('failed');
      expect(job.phase).toBe('failed');
      expect(job.error).toMatch(/校验失败/);
      expect(job.error).toMatch(/已丢弃/);
      expect(job.install).toBeUndefined();
      // 目标目录没被创建
      expect(existsSync(target)).toBe(false);
      // 暂存目录没留下
      expect(readdirSync(join(workDir, 'install')).filter((f) => f.includes('napcat-install-'))).toEqual([]);
      // 台账里没有这条
      expect(host.list()).toHaveLength(0);
    });

    it('下载中途断开：作业失败、无残留', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip, 'truncated'));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');

      const job = await runInstall(host, requestFor(server, sha, target));

      expect(job.state).toBe('failed');
      expect(job.phase).toBe('failed');
      expect(job.error).toBeTruthy();
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(join(workDir, 'install')).filter((f) => f.includes('napcat-install-'))).toEqual([]);
      expect(host.list()).toHaveLength(0);
    });

    it('HTTP 错误：作业失败、无残留', async () => {
      const server = await track(await startServer(Buffer.from('nope'), 'error'));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');

      const job = await runInstall(host, requestFor(server, 'a'.repeat(64), target));

      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/500/);
      expect(existsSync(target)).toBe(false);
      expect(host.list()).toHaveLength(0);
    });

    it('压缩包损坏（不是 zip）：解压失败后目录被清干净', async () => {
      const garbage = Buffer.from('this is definitely not a zip archive');
      const sha = createHash('sha256').update(garbage).digest('hex');
      const server = await track(await startServer(garbage));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');

      const job = await runInstall(host, requestFor(server, sha, target));

      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/解压失败/);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(join(workDir, 'install')).filter((f) => f.includes('napcat-install-'))).toEqual([]);
      expect(host.list()).toHaveLength(0);
    });

    it('失败信息里不出现本机绝对路径', async () => {
      const zip = buildArtifactZip();
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');

      const job = await runInstall(host, requestFor(server, 'c'.repeat(64), target));
      expect(job.state).toBe('failed');
      expect(job.error).not.toContain(workDir);
    });

    it('安装目录是相对路径时直接失败（不给含糊的结果）', async () => {
      const host = newHost();
      const job = await runInstall(host, {
        dir: 'relative/path',
        version: '4.18.42',
        mode: 'standalone',
        url: 'http://127.0.0.1:1/x.zip',
        sha256: 'a'.repeat(64),
        allowedHosts: ['127.0.0.1'],
      });
      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/绝对路径/);
    });
  });

  // ── ⑤ 配置、注入模式与凭据 ──────────────────────────────────────

  describe('配置与注入模式', () => {
    it('注入模式：qqnt.json 以本机桌面 QQ 的 package.json 为底，main 换成 loadNapCat.js', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip));
      const host = newHost();

      // 造一个「桌面 QQ 安装根」：<root>/versions/9.9.37/resources/app/package.json
      const qqRoot = join(workDir, 'QQ');
      const appDir = join(qqRoot, 'versions', '9.9.37', 'resources', 'app');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ name: 'qq', version: '9.9.37-54395', buildVersion: '54395', main: './app.js' }),
        'utf-8',
      );

      const target = join(workDir, 'install', 'napcat-inject');
      const job = await runInstall(host, {
        dir: target,
        version: '4.18.42',
        mode: 'inject',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
        desktopQqRoots: [qqRoot],
      });

      expect(job.state).toBe('succeeded');
      const qqnt = JSON.parse(readFileSync(join(target, 'napcat', 'qqnt.json'), 'utf-8'));
      expect(qqnt.main).toBe('./loadNapCat.js');
      // 版本号 / buildVersion 必须与本机一致
      expect(qqnt.version).toBe('9.9.37-54395');
      expect(qqnt.buildVersion).toBe('54395');
      expect(job.notes?.join('\n')).toMatch(/qqnt\.json/);
    });

    it('注入模式：找不到桌面 QQ 时保留制品自带的 qqnt.json，并在作业说明里讲清楚', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-inject');

      const job = await runInstall(host, {
        dir: target,
        version: '4.18.42',
        mode: 'inject',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
        desktopQqRoots: [join(workDir, '不存在的QQ根')],
      });

      expect(job.state).toBe('succeeded');
      const qqnt = JSON.parse(readFileSync(join(target, 'napcat', 'qqnt.json'), 'utf-8'));
      expect(qqnt).toEqual(ARTIFACT_QQNT);
      expect(job.notes?.join('\n')).toMatch(/未找到本机桌面 QQ/);
    });

    it('独立模式不改写 qqnt.json（不需要注入）', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-standalone');

      await runInstall(host, {
        dir: target,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
      });

      const qqnt = JSON.parse(readFileSync(join(target, 'napcat', 'qqnt.json'), 'utf-8'));
      expect(qqnt).toEqual(ARTIFACT_QQNT);
    });

    it('已知 uin 时写 onebot11_<uin>.json；未知 uin 时跳过并在说明里讲清楚', async () => {
      const zip = buildArtifactZip();
      const sha = createHash('sha256').update(zip).digest('hex');
      const server = await track(await startServer(zip));
      const host = newHost();

      const withUin = join(workDir, 'install', 'napcat-uin');
      await runInstall(host, {
        dir: withUin,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
        uin: '987654321',
      });
      expect(existsSync(join(withUin, 'napcat', 'config', 'onebot11_987654321.json'))).toBe(true);

      const withoutUin = join(workDir, 'install', 'napcat-no-uin');
      const job = await runInstall(host, {
        dir: withoutUin,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: sha,
        allowedHosts: ['127.0.0.1'],
      });
      expect(readdirSync(join(withoutUin, 'napcat', 'config')).filter((f) => f.startsWith('onebot11'))).toEqual([]);
      expect(job.notes?.join('\n')).toMatch(/uin/);
    });

    it('桌面 QQ 的发现：版本目录优先，且取版本号最新的那个', () => {
      const root = join(workDir, 'QQ');
      const mk = (version: string, build: string): void => {
        const dir = join(root, 'versions', version, 'resources', 'app');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ version, buildVersion: build }), 'utf-8');
      };
      mk('9.9.30', '111');
      mk('9.9.37', '222');
      const found = findDesktopQqPackage([root]);
      expect(found?.version).toBe('9.9.37');
      expect(found?.buildVersion).toBe('222');
      expect(findDesktopQqPackage([join(workDir, '不存在的根')])).toBeUndefined();
    });

    it('maskSecret 不泄露明文', () => {
      const token = 'a'.repeat(48);
      const masked = maskSecret(token);
      expect(masked).not.toBe(token);
      expect(masked).not.toContain(token);
      expect(masked).toMatch(/\*{4}/);
      expect(maskSecret('short')).toBe('***');
      expect(maskSecret(undefined)).toBeUndefined();
    });

    it('文案里的本机绝对路径会被替换掉，但网址不能被误伤', () => {
      expect(scrubLocalPaths('打开 C:\\Users\\me\\x 失败', 'win32')).toContain('<路径>');
      expect(scrubLocalPaths('打开 C:\\Users\\me\\x 失败', 'win32')).not.toContain('C:\\');
      // 网址不是本机路径，不能被替换掉（否则错误提示会变得没法看）
      expect(scrubLocalPaths('见 https://github.com/a/b', 'win32')).toContain('https://github.com/a/b');
      expect(scrubLocalPaths('读 /home/me/x 失败', 'linux')).toContain('<路径>');
      expect(scrubLocalPaths('读 /home/me/x 失败', 'linux')).not.toContain('/home/me/x');
    });
  });

  // ── ⑥ pid（Task 3 的接口约定） ───────────────────────────────────

  describe('pid 记录', () => {
    it('setPid / pidOf / 清除 pid：落盘后仍然在', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      const install = makeInstall(dir);
      host.add(install);

      expect(host.pidOf(install.id)).toBeUndefined();
      host.setPid(install.id, 4242);
      expect(host.pidOf(install.id)).toBe(4242);

      const reopened = newHost();
      expect(reopened.pidOf(install.id)).toBe(4242);

      reopened.setPid(install.id, undefined);
      expect(reopened.pidOf(install.id)).toBeUndefined();
      expect(newHost().pidOf(install.id)).toBeUndefined();
    });

    it('安装视图里带 pid，但不带 token 明文', () => {
      const host = newHost();
      const dir = join(workDir, 'napcat-4.18.42');
      const install = makeInstall(dir);
      host.add(install);
      host.setPid(install.id, 777);
      const view = host.view(host.get(install.id)!);
      expect(view.pid).toBe(777);
      expect(view.webuiTokenMasked).toBeUndefined();
    });
  });

  // ── 审查修复项：脱敏兜底 / 僵死作业 / 孤儿凭据 ──────────────────────

  describe('审查修复', () => {
    it('脱敏器抛异常时不会把原文放出去（宁可丢内容）', () => {
      const host = newHost({
        redact: () => {
          throw new Error('脱敏器坏了');
        },
      });
      const out = host.redactText('这里有不该出现的原文');
      expect(out).not.toContain('不该出现的原文');
      expect(out).toContain('已省略');
    });

    it('上次停在 running 的作业：重开时判为失败（面板不会永远转圈）', () => {
      const jobsPath = join(dataDir, 'managed-install-jobs.json');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        jobsPath,
        JSON.stringify({
          schemaVersion: 1,
          jobs: [
            {
              id: 'job-stuck',
              startedAt: new Date().toISOString(),
              state: 'running',
              phase: 'downloading',
              bytesReceived: 10,
              request: {
                dir: join(workDir, 'napcat-4.18.42'),
                version: '4.18.42',
                mode: 'standalone',
                url: 'http://127.0.0.1:1/a.zip',
                sha256: 'd'.repeat(64),
                allowedHosts: ['127.0.0.1'],
              },
            },
          ],
        }),
      );
      const host = newHost();
      const job = host.getJob('job-stuck');
      expect(job?.state).toBe('failed');
      expect(job?.error).toContain('中断');
    });

    it('安装失败后不留孤儿 token（凭据文件里没有这个目录）', async () => {
      const zip = buildArtifactZip();
      const server = await track(await startServer(zip));
      const host = newHost();
      const target = join(workDir, 'install', 'napcat-4.18.42');
      const job = await runInstall(host, {
        dir: target,
        version: '4.18.42',
        mode: 'standalone',
        url: `http://127.0.0.1:${server.port}/artifact.zip`,
        sha256: 'e'.repeat(64), // 故意不匹配 → 安装失败
        allowedHosts: ['127.0.0.1'],
      });
      expect(job.state).toBe('failed');
      expect(host.maskWebuiToken(target)).toBeUndefined();
    });
  });
});
