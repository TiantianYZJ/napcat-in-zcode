/**
 * 受管宿主的进程监管：启动 / 停止 / 状态判定。
 *
 * 这里用**真实的子进程**冒充被监管的实例（不碰真实 NapCat、真实 QQ）：
 * - 安装目录里放一份当前 Node 可执行文件的副本并命名为 `node.exe`（一次性），
 *   `index.js` 里起一个长驻定时器 → 就是一个可控的「受管进程」；
 * - 端口用本地临时 TCP server 占随机端口（WebUI 侧）与本地 HTTP server（OneBot 侧）。
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ManagedHost } from '../src/server/host/manager.js';
import {
  INJECT_MODE_WARNING,
  isProcessAlive,
  probeManagedHost,
  resolveDesktopQqPath,
  startManagedHost,
  stopManagedHost,
  tcpReachable,
} from '../src/server/host/supervise.js';

const tmp = mkdtempSync(join(tmpdir(), 'napcat-supervise-'));
const hosts: ManagedHost[] = [];
const children: number[] = [];

/**
 * 新建一个台账；给了 install 就把它**登记进去**
 * （`setPid` 只对已登记的安装生效，否则 pid 记不上）。
 */
function newHost(install?: FakeInstall['install']): ManagedHost {
  const host = new ManagedHost({ dataDir: join(tmp, `data-${hosts.length}`) });
  hosts.push(host);
  if (install) host.add(install);
  return host;
}

interface FakeInstall {
  dir: string;
  install: {
    id: string;
    dir: string;
    version: string;
    mode: 'standalone' | 'inject';
    installedAt: string;
    artifactSha256: string;
  };
}

/** 造一个「独立模式」的受管安装目录（里面有一份可执行的 node.exe）。 */
function makeInstall(mode: 'standalone' | 'inject' = 'standalone'): FakeInstall {
  const dir = join(tmp, `install-${mode}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  if (mode === 'standalone') {
    // 一次性把当前 Node 可执行文件复制成安装目录里的 node.exe（独立模式启动的就是它）
    copyFileSync(process.execPath, join(dir, 'node.exe'));
    // 长驻进程：每 250ms 追加一次心跳文件
    writeFileSync(
      join(dir, 'index.js'),
      'setInterval(() => { require("fs").appendFileSync("alive.txt", "x"); }, 250);\n',
    );
  } else {
    mkdirSync(join(dir, 'napcat'), { recursive: true });
    // 注入模式启动的是 NapCatWinBootMain.exe；这里用一份真的可执行文件顶替
    // （它会把第一个参数当脚本跑，所以下面的 QQ.exe 得写成 JS 才能长驻）
    copyFileSync(process.execPath, join(dir, 'napcat', 'NapCatWinBootMain.exe'));
  }
  return {
    dir,
    install: {
      id: `napcat-4.18.42-${mode}`,
      dir,
      version: '4.18.42',
      mode,
      installedAt: new Date().toISOString(),
      artifactSha256: 'a'.repeat(64),
    },
  };
}

/** 端口被占着（TCP 层） */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createTcpServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

/** 假装是 OneBot 的 HTTP 端点（会应答 get_login_info） */
async function occupyOneBot(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 2350355494, nickname: '监管测试号' } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

/** 拉起一个长驻的假进程（当受管实例用） */
function spawnSleeper(): number {
  const child = spawn('node', ['-e', 'setInterval(()=>{}, 250)'], { stdio: 'ignore' });
  const pid = child.pid!;
  children.push(pid);
  return pid;
}

afterAll(async () => {
  for (const pid of children) {
    try {
      process.kill(pid);
    } catch {
      /* 已经没了 */
    }
  }
  await new Promise<void>((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true });
});

describe('受管宿主的进程监管', () => {
  it('独立模式：启动后 pid 记进台账，停止后 pid 被清除', async () => {
    const fake = makeInstall('standalone');
    const host = newHost(fake.install);
    const started = await startManagedHost(fake.install, { host });
    expect(started.pid).toBeGreaterThan(0);
    expect(host.pidOf(fake.install.id)).toBe(started.pid);
    expect(started.message).toContain('独立模式');
    expect(started.warning).toBeUndefined();
    const res = await stopManagedHost(
      { state: 'running', pid: started.pid, install: host.view(fake.install) },
      { host },
    );
    expect(res.stopped).toBe(true);
    expect(host.pidOf(fake.install.id)).toBeUndefined();
  });

  it('注入模式：启动时带风险提示', async () => {
    const fake = makeInstall('inject');
    const host = newHost(fake.install);
    const qqPath = join(tmp, 'QQ.exe');
    // 顶替程序会把第一个参数当脚本执行 → 写成 JS 才能长驻
    writeFileSync(qqPath, 'setInterval(()=>{}, 250);\n');
    const started = await startManagedHost(fake.install, { host, desktopQqPath: qqPath });
    expect(started.warning).toBe(INJECT_MODE_WARNING);
    expect(started.warning).toContain('文件已损坏');
    await stopManagedHost(
      { state: 'running', pid: started.pid, install: host.view(fake.install) },
      { host },
    );
  });

  it('安装目录里缺程序时明确报错，不去解析系统 PATH 上的同名程序', async () => {
    const dir = join(tmp, `empty-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const host = newHost();
    const install = {
      id: 'napcat-empty',
      dir,
      version: '4.18.42',
      mode: 'standalone' as const,
      installedAt: new Date().toISOString(),
      artifactSha256: 'b'.repeat(64),
    };
    await expect(startManagedHost(install, { host })).rejects.toThrow(/找不到 node\.exe/);
  });

  it('停止：台账里没有 pid 时拒绝，并说明不是本插件启动的实例', async () => {
    const host = newHost();
    const res = await stopManagedHost({ state: 'running' }, { host });
    expect(res.stopped).toBe(false);
    expect(res.message).toContain('不是本插件启动的');
  });

  it('停止：进程已经不在时如实说明，无需再停', async () => {
    const host = newHost();
    const res = await stopManagedHost({ state: 'running', pid: 999999 }, { host });
    expect(res.stopped).toBe(false);
    expect(res.message).toContain('已不在');
  });

  it('停止：连子孙进程一起停掉', async () => {
    const host = newHost();
    const pid = spawnSleeper();
    const fake = makeInstall('standalone');
    host.setPid(fake.install.id, pid);
    const res = await stopManagedHost({ state: 'running', pid, install: host.view(fake.install) }, { host });
    expect(res.stopped).toBe(true);
    expect(res.message).toContain('已停止');
    expect(isProcessAlive(pid)).toBe(false);
    expect(host.pidOf(fake.install.id)).toBeUndefined();
  });

  it('状态：没记录 pid、端口也没人听 → 未运行', async () => {
    const fake = makeInstall('standalone');
    const host = newHost(fake.install);
    const status = await probeManagedHost(fake.install, {
      host,
      webuiPort: 1,
      onebotPort: 2,
      probeTimeoutMs: 300,
    });
    expect(status.state).toBe('stopped');
    expect(status.message).toContain('未运行');
  });

  it('状态：没记录 pid 但端口有人听 → unknown（端口被别的实例占着）', async () => {
    const fake = makeInstall('standalone');
    const host = newHost(fake.install);
    const occupied = await occupyPort();
    try {
      const status = await probeManagedHost(fake.install, {
        host,
        webuiPort: occupied.port,
        onebotPort: occupied.port,
        probeTimeoutMs: 500,
      });
      expect(status.state).toBe('unknown');
      expect(status.message).toContain('别的实例');
    } finally {
      await occupied.close();
    }
  });

  it('状态：pid 在、端口还没通 → 正在启动', async () => {
    const fake = makeInstall('standalone');
    const host = newHost(fake.install);
    const pid = spawnSleeper();
    host.setPid(fake.install.id, pid);
    const status = await probeManagedHost(fake.install, {
      host,
      webuiPort: 1,
      onebotPort: 2,
      probeTimeoutMs: 300,
    });
    expect(status.state).toBe('starting');
    expect(status.message).toContain('正在启动');
  });

  it('状态：pid 在、WebUI 通但 OneBot 不通 → 降级（提示去 WebUI 开 OneBot）', async () => {
    const fake = makeInstall('standalone');
    const host = newHost(fake.install);
    const pid = spawnSleeper();
    host.setPid(fake.install.id, pid);
    const occupied = await occupyPort();
    try {
      const status = await probeManagedHost(fake.install, {
        host,
        webuiPort: occupied.port,
        onebotPort: 2,
        probeTimeoutMs: 500,
      });
      expect(status.state).toBe('degraded');
      // 文案用用户语言（不说 OneBot 这种内部协议名）
      expect(status.message).toContain('聊天数据还没接上');
      expect(status.message).not.toContain('OneBot');
    } finally {
      await occupied.close();
    }
  });

  it('状态：pid 在、WebUI 与 OneBot 都通 → 运行中（带登录信息）', async () => {
    const fake = makeInstall('standalone');
    const host = newHost(fake.install);
    const pid = spawnSleeper();
    host.setPid(fake.install.id, pid);
    const webui = await occupyPort();
    const onebot = await occupyOneBot();
    try {
      const status = await probeManagedHost(fake.install, {
        host,
        webuiPort: webui.port,
        onebotPort: onebot.port,
        probeTimeoutMs: 800,
      });
      expect(status.state).toBe('running');
      expect(status.login?.nickname).toBe('监管测试号');
      expect(status.message).toContain('运行中');
    } finally {
      await webui.close();
      await onebot.close();
    }
  });

  it('桌面 QQ 路径：优先用设置里的，其次安装目录里的 qq_path.txt', async () => {
    const fake = makeInstall('inject');
    const host = newHost(fake.install);
    const configured = join(tmp, 'QQ-configured.exe');
    writeFileSync(configured, 'fake');
    expect(resolveDesktopQqPath(fake.install, { host, desktopQqPath: configured })).toBe(configured);

    mkdirSync(join(fake.dir, 'napcat', 'config'), { recursive: true });
    writeFileSync(join(fake.dir, 'napcat', 'config', 'qq_path.txt'), configured);
    expect(resolveDesktopQqPath(fake.install, { host })).toBe(configured);
  });

  it('桌面 QQ 路径：找不到时明确报错并建议改用独立模式', async () => {
    const fake = makeInstall('inject');
    const host = newHost(fake.install);
    expect(() => resolveDesktopQqPath(fake.install, { host })).toThrow(/独立模式/);
  });

  it('端口探测：没人听的端口返回 false', async () => {
    expect(await tcpReachable(1, 300)).toBe(false);
  });
});
