/**
 * 端口自适应与残留进程清理（0.12.4）。
 *
 * 场景：用户自己跑着一个 NapCat，占着默认的 6099/3000——
 * 插件的受管实例若硬用同一组端口，只会得到一个绑定失败的半成品，
 * 二维码/卸载也跟着死锁。解法：
 * - 启动前探测到端口被占 → **自动改配一组空闲端口**（重写实例自己的
 *   webui.json / onebot11.json 端口并更新台账），各实例端口独立；
 * - 卸载遇 EPERM（残留进程锁着安装目录）→ 只结束**可执行路径位于
 *   该目录内**的进程（PowerShell 查询 + 树杀），然后重试删除——
 *   不碰目录之外的任何进程。
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 探测 127.0.0.1:port 是否可以绑定（可绑定 = 空闲）。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ host: '127.0.0.1', port }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * 从 preferred + 1 起找一组互不冲突、且当前空闲的端口。
 * 返回 null = 找不到（不太可能，范围 32 个足够宽）。
 */
export async function findFreePorts(
  webuiPreferred: number,
  onebotPreferred: number,
): Promise<{ webuiPort: number; onebotPort: number } | null> {
  const taken = new Set<number>();
  const pick = async (base: number): Promise<number | undefined> => {
    for (let p = base + 1; p <= base + 32; p++) {
      if (taken.has(p)) continue;
      if (await isPortFree(p)) {
        taken.add(p);
        return p;
      }
    }
    return undefined;
  };
  const webuiPort = await pick(webuiPreferred);
  if (webuiPort === undefined) return null;
  const onebotPort = await pick(onebotPreferred);
  if (onebotPort === undefined) return null;
  return { webuiPort, onebotPort };
}

/** 便捷组合：找不到空闲端口时抛出带指引的错误。 */
export async function remapFreePorts(
  preferred: { webuiPort: number; onebotPort: number },
): Promise<{ webuiPort: number; onebotPort: number }> {
  const found = await findFreePorts(preferred.webuiPort, preferred.onebotPort);
  if (!found) {
    throw new Error('6099/3000 附近的端口都被占用了，找不到可用的端口。');
  }
  return found;
}

/** NapCat 配置目录的两种布局（受管 install.dir 下都试）。 */
function configDirs(dir: string): string[] {
  return [join(dir, 'napcat', 'config'), join(dir, 'config')];
}

/** 把实例配置里的端口改写为新的（webui.json 的 port + onebot11*.json 的 httpServers[].port）。 */
export function rewriteNapcatPorts(dir: string, ports: { webuiPort: number; onebotPort: number }): void {
  for (const configDir of configDirs(dir)) {
    try {
      const webuiPath = join(configDir, 'webui.json');
      const webui = JSON.parse(readFileSync(webuiPath, 'utf8')) as { port?: number };
      if (Number.isInteger(webui.port)) {
        webui.port = ports.webuiPort;
        writeFileSync(webuiPath, JSON.stringify(webui, null, 2), 'utf-8');
      }
    } catch {
      /* 没有 webui.json 就不动 */
    }
    try {
      const p = join(configDir, 'onebot11.json');
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as {
        network?: { httpServers?: Array<{ port?: number }> };
      };
      const http = cfg.network?.httpServers?.[0];
      if (http && Number.isInteger(http.port)) {
        http.port = ports.onebotPort;
        writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
      }
    } catch {
      /* 没有 onebot11 配置就不动 */
    }
  }
}

/**
 * 结束**可执行路径位于 dir 内**的所有进程（PowerShell 查询 + 树杀）。
 * 卸载遇 EPERM 时的解锁手段：只碰目录内的残留（NapCat / QQ 子进程），
 * 目录之外的进程一律不碰。返回结束掉的 pid 数。
 */
export async function killProcessesUnder(dir: string): Promise<number> {
  const escaped = dir.replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.ExecutablePath -like '${escaped}*' } | ` +
    `Select-Object -ExpandProperty ProcessId`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15_000 },
  );
  const pids = stdout
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const pid of pids) {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 });
    } catch {
      /* 已经退出的忽略 */
    }
  }
  return pids.length;
}
