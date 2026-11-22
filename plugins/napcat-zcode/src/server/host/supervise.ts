/**
 * 受管宿主的**进程监管**：启动 / 停止 / 状态判定。
 *
 * 三条不可让步的边界（越权就是 bug）：
 *
 * 1. **只管插件自己拉起的进程。** pid 的唯一权威来源是受管台账（`ManagedHost.setPid`）。
 *    台账里没有这个 pid → 停止必须被拒绝（「不是本插件启动的实例」）。
 * 2. **端口被外部实例占用 ≠ 我们的实例。** 此时状态是 `unknown`，
 *    如实说「端口已被其他实例占用」，**不**声称是自己的，也**不**去杀它。
 * 3. **探测是只读的。** 不改用户的 NapCat 配置，不自动启动任何东西。
 *
 * 启动方式：一律 `shell: false` + **参数数组**（不经 shell，没有命令注入面）。
 * 被执行的程序名是**固定字面量**；受管安装目录只通过**子进程自己的 PATH 前缀**
 * 参与解析（目录里那个同名文件是插件自己校验 sha256 后解压出来的），
 * 并且启动前先确认它确实存在。
 *
 * 注入模式需要的**桌面 QQ 路径**只从「插件设置」或安装目录里的 `qq_path.txt` 取
 * （**不读注册表**、不扫描磁盘、不猜路径）——找不到就明确报错并建议改用独立模式。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join } from 'node:path';
import type { ManagedHost, ManagedInstall, ManagedInstallView, ManagedMode } from './manager.js';
import { DEFAULT_ONEBOT_PORT, DEFAULT_WEBUI_PORT } from './manager.js';

/** 受管宿主的运行状态。 */
export type HostState =
  /** 目录里没有受管安装。 */
  | 'not-installed'
  /** 没在跑（本插件也没记录 pid）。 */
  | 'stopped'
  /** 刚拉起、端口还没通。 */
  | 'starting'
  /** 在跑，WebUI 与 OneBot 都通。 */
  | 'running'
  /** 在跑，但 OneBot Server 没开（NapCat 只起了 WebUI）。 */
  | 'degraded'
  /** 本插件的 pid 没了，但端口还通 → 端口被别的实例占着。 */
  | 'unknown';

export interface HostStatus {
  state: HostState;
  /** 受管安装（视图形态：token 只以掩码出现）。 */
  install?: ManagedInstallView;
  /** 本插件记录的 pid（**只有它自己拉起的进程**才有）。 */
  pid?: number;
  webuiPort?: number;
  /** WebUI 端口是否可达（TCP 层探测，不用 HTTP——WebUI 可能要 token）。 */
  webuiReachable?: boolean;
  onebotPort?: number;
  onebotPortReachable?: boolean;
  /** OneBot 登录信息（仅在 OneBot 可达时才有）。 */
  login?: { user_id: string; nickname: string };
  /** 面向用户的中文说明。 */
  message?: string;
}

export interface SuperviseOptions {
  /** 受管台账（pid 的唯一权威来源）。 */
  host: ManagedHost;
  /** WebUI 端口（默认 6099）。 */
  webuiPort?: number;
  /** OneBot HTTP 端口（默认 3000）。 */
  onebotPort?: number;
  /** 端口探测超时（毫秒，默认 1200）。 */
  probeTimeoutMs?: number;
  /** 平台（默认当前平台）。 */
  platform?: NodeJS.Platform;
  /** 桌面 QQ 的可执行文件路径（注入模式用；来自插件设置）。 */
  desktopQqPath?: string;
}

export interface StartResult {
  pid: number;
  mode: ManagedMode;
  /** 面向用户的中文说明。 */
  message: string;
  /** 风险提示（注入模式才有）。 */
  warning?: string;
}

export interface StopResult {
  stopped: boolean;
  message: string;
  /** 是否只杀掉了主进程（子孙可能残留）。 */
  descendantsMayRemain?: boolean;
}

/** 注入模式的风险提示：QQ 9.9.36+ 有原生完整性检查。 */
export const INJECT_MODE_WARNING =
  '注入模式会启动桌面 QQ 并向其进程注入本组件。QQ 9.9.36 及以上版本在启动前会做原生完整性检查，' +
  '注入可能导致它报「文件已损坏，请重新安装」并中止启动。不确定时用独立模式（不影响桌面 QQ）。';

/** 进程是否还活着。 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在；EPERM = 存在但当前用户无权发信号（仍算活着）
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** TCP 层探测：端口有没有人在听。 */
export function tcpReachable(port: number, timeoutMs = 1200, host = '127.0.0.1'): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 取 OneBot 的登录信息（拿不到就返回 undefined，不算错误）。 */
export async function fetchLoginInfo(
  port: number,
  timeoutMs = 1500,
): Promise<{ user_id: string; nickname: string } | undefined> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      retcode?: number;
      data?: { user_id?: string | number; nickname?: string };
    };
    if (json?.retcode !== 0) return undefined;
    const id = json.data?.user_id;
    const nickname = json.data?.nickname;
    if (id === undefined || !nickname) return undefined;
    return { user_id: String(id), nickname };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 子进程的 PATH：把受管目录放到**最前面**。
 *
 * 这样固定字面量的程序名（`node.exe` / `NapCatWinBootMain.exe`）解析到的就是受管安装
 * 目录里插件自己解压出来的那一份，而不是系统 PATH 上的同名程序。
 */
function pathWithFirst(dir: string): string {
  return `${dir}${delimiter}${process.env.PATH ?? ''}`;
}

/** 确认受管安装里确实有那个程序（不存在就别启动，免得解析到别处的同名程序）。 */
function assertManagedProgram(dir: string, fileName: string): void {
  if (!existsSync(join(dir, fileName))) {
    throw new Error(`启动失败：安装目录里找不到 ${fileName}（安装可能不完整）。`);
  }
}

/** 启动一个受管实例，并把 pid 记进台账。 */
export async function startManagedHost(
  install: ManagedInstall,
  opts: SuperviseOptions,
): Promise<StartResult> {
  if (!install || !install.dir) {
    throw new Error('启动失败：安装信息无效。');
  }
  const mode: ManagedMode = install.mode ?? 'standalone';

  if (mode === 'inject') {
    const napcatDir = join(install.dir, 'napcat');
    assertManagedProgram(napcatDir, 'NapCatWinBootMain.exe');
    const qqPath = resolveDesktopQqPath(install, opts);
    const hook = join(napcatDir, 'NapCatWinBootHook.dll');
    // 与上游 launcher-user.bat 等价的环境变量（hook 从环境里取路径）
    const child = spawn('NapCatWinBootMain.exe', [qqPath, hook], {
      cwd: napcatDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PATH: pathWithFirst(napcatDir),
        NAPCAT_PATCH_PACKAGE: join(napcatDir, 'qqnt.json'),
        NAPCAT_LOAD_PATH: join(napcatDir, 'loadNapCat.js'),
        NAPCAT_INJECT_PATH: hook,
        NAPCAT_LAUNCHER_PATH: join(napcatDir, 'NapCatWinBootMain.exe'),
        NAPCAT_MAIN_PATH: join(napcatDir, 'napcat.mjs'),
      },
    });
    await waitForSpawn(child);
    if (!child.pid) {
      throw new Error('启动失败：注入模式的启动器没能拉起进程。');
    }
    opts.host.setPid(install.id, child.pid);
    return {
      pid: child.pid,
      mode,
      message: '已启动（注入模式）。',
      warning: INJECT_MODE_WARNING,
    };
  }

  // 独立模式：自带 node.exe 与内嵌 QQNT，完全不碰桌面 QQ
  assertManagedProgram(install.dir, 'node.exe');
  const child = spawn('node.exe', ['index.js'], {
    cwd: install.dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    env: { ...process.env, PATH: pathWithFirst(install.dir) },
  });
  await waitForSpawn(child);
  if (!child.pid) {
    throw new Error('启动失败：没能拉起进程。');
  }
  opts.host.setPid(install.id, child.pid);
  return {
    pid: child.pid,
    mode,
    message: '已启动（独立模式，不影响桌面 QQ）。',
  };
}

/** 停止一个受管实例（只认台账里自己记下的 pid）。 */
export async function stopManagedHost(status: HostStatus, opts: SuperviseOptions): Promise<StopResult> {
  const pid = status?.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return {
      stopped: false,
      message: '这个实例不是本插件启动的，无法停止。',
    };
  }
  const platform = opts.platform ?? process.platform;
  let descendantsMayRemain = false;

  if (platform === 'win32') {
    const killed = await taskkill(pid);
    if (!killed) {
      // taskkill 不可用 → 只杀主进程，子孙可能残留
      descendantsMayRemain = true;
      try {
        process.kill(pid);
      } catch {
        return { stopped: false, message: '停止失败：进程已不在，无需停止。' };
      }
    }
  } else {
    try {
      // 负 pid = 整个进程组
      process.kill(-pid);
    } catch {
      try {
        process.kill(pid);
        descendantsMayRemain = true;
      } catch {
        return { stopped: false, message: '停止失败：进程已不在，无需停止。' };
      }
    }
  }

  const gone = await waitProcessGone(pid, 6000);
  if (!gone) {
    return {
      stopped: false,
      message: '已发出终止信号，但进程尚未退出。',
      descendantsMayRemain,
    };
  }
  if (status.install?.id) {
    try {
      opts.host.setPid(status.install.id, undefined);
    } catch {
      /* 台账清理失败不影响「进程已停」这个事实 */
    }
  }
  return {
    stopped: true,
    message: descendantsMayRemain
      ? '已停止（只结束了主进程，子孙进程可能仍在运行）。'
      : '已停止。',
    descendantsMayRemain,
  };
}

/** 判定受管实例的状态。 */
export async function probeManagedHost(
  install: ManagedInstall,
  opts: SuperviseOptions,
): Promise<HostStatus> {
  const webuiPort = opts.webuiPort ?? DEFAULT_WEBUI_PORT;
  const onebotPort = opts.onebotPort ?? DEFAULT_ONEBOT_PORT;
  const timeoutMs = opts.probeTimeoutMs ?? 1200;

  const pid = install ? opts.host.pidOf(install.id) : undefined;
  const alive = isProcessAlive(pid);

  const [webuiReachable, onebotReachable] = await Promise.all([
    tcpReachable(webuiPort, timeoutMs),
    tcpReachable(onebotPort, timeoutMs),
  ]);

  const base: HostStatus = {
    state: 'stopped',
    install: install ? opts.host.view(install) : undefined,
    pid,
    webuiPort,
    webuiReachable,
    onebotPort,
    onebotPortReachable: onebotReachable,
  };

  if (!alive) {
    if (webuiReachable || onebotReachable) {
      return {
        ...base,
        state: 'unknown',
        message: '端口上还有别的实例在跑，但这个安装不是本插件启动的进程（无法托管它）。',
      };
    }
    return { ...base, state: 'stopped', message: '未运行。' };
  }

  if (!webuiReachable) {
    return { ...base, state: 'starting', message: '正在启动，端口还没通。' };
  }
  if (!onebotReachable) {
    return {
      ...base,
      state: 'degraded',
      message: 'NapCat 在跑，但 OneBot Server 没开（需要在 WebUI 里开启，插件不会代开）。',
    };
  }
  const login = await fetchLoginInfo(onebotPort, timeoutMs + 300);
  return {
    ...base,
    state: 'running',
    login,
    message: login ? `运行中（已登录 ${login.nickname}）。` : '运行中。',
  };
}

// ── 内部实现 ────────────────────────────────────────────────────────

/**
 * 桌面 QQ 的可执行文件路径（注入模式需要）。
 *
 * 来源只有两处：插件设置里的 `desktopQqPath`、安装目录里保存的 `qq_path.txt`
 * （QCE 的惯例）。**不读注册表、不扫磁盘、不猜路径** —— 找不到就报错。
 */
export function resolveDesktopQqPath(install: ManagedInstall, opts: SuperviseOptions): string {
  const configured = opts.desktopQqPath?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error('注入模式配置的桌面 QQ 路径不存在，请检查设置。');
    }
    return configured;
  }
  for (const rel of [
    ['napcat', 'config', 'qq_path.txt'],
    ['config', 'qq_path.txt'],
  ]) {
    try {
      const text = readFileSync(join(install.dir, ...rel), 'utf8').trim();
      if (text) {
        if (!existsSync(text)) {
          throw new Error('注入模式保存的桌面 QQ 路径已失效（文件不存在），请重新设置。');
        }
        return text;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('路径已失效')) throw err;
      /* 没有这个文件就试下一个 */
    }
  }
  throw new Error(
    '没有找到桌面 QQ。请在插件设置里填写 QQ.exe 的路径，或改用独立模式（不影响桌面 QQ）。',
  );
}

/** 等子进程真正起来（并把「立刻就死」当成启动失败）。 */
async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) {
    await new Promise<void>((resolve) => {
      child.once('error', () => resolve());
      child.once('spawn', () => resolve());
      setTimeout(resolve, 3000);
    });
    return;
  }
  child.unref();
  // 给它一点时间：秒退（例如路径错）要如实报「启动失败」而不是「已启动」
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  if (!isProcessAlive(child.pid)) {
    throw new Error('启动失败：进程刚拉起就退出了（可能是安装目录不完整或启动脚本报错）。');
  }
}

/** `taskkill /T /F` 杀进程树；返回是否成功执行。 */
async function taskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** 轮询等进程真的消失。 */
async function waitProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return !isProcessAlive(pid);
}
