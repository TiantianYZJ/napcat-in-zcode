/**
 * M3 受管宿主的 MCP 工具层。
 *
 * 六个工具，覆盖用户要的那条完整链路：
 * **没装 → 下载安装 → 启动 → 停止**，以及随时查看状态。
 *
 * 设计上的几条硬规矩：
 *
 * 1. **下载不阻塞在工具调用里**：`napcat_install` 起一个后台作业就立刻返回 `jobId`，
 *    面板轮询 `napcat_install_status` 看进度（124MB 的下载不能把一次工具调用挂住）。
 * 2. **只管插件自己拉起的进程**：停止操作认的是受管台账里的 pid，
 *    台账里没有 → 拒绝并说明「不是本插件启动的实例」。
 * 3. **token 不出参**：WebUI token 一律掩码（`host.view()` 已经保证）。
 * 4. **动作名与结果名一致**：点了「启动」就说「已启动」，不玩文字游戏。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dataDir } from '../config.js';
import { fail, ok } from '../tool-results.js';
import type { AppState } from '../state.js';
import { availableVersions, resolveArtifact } from './artifacts.js';
import {
  assertInstallTargetSafe,
  deriveInstallId,
  ManagedHost,
  newJobId,
  type InstallJob,
  type ManagedInstall,
} from './manager.js';
import { pollQrLogin } from './qrlogin.js';
import { killProcessesUnder, findFreePorts, rewriteNapcatPorts, remapFreePorts } from './portfix.js';
import { probeManagedHost, startManagedHost, stopManagedHost, type HostStatus } from './supervise.js';

/** 面板资源 URI（必须与清单 `ui.surfaces[0].resourceUri` 一致）。 */
const PANEL_URI = 'ui://napcat-zcode/panel.html';
/** 面板 surface id（必须与清单 `ui.surfaces[0].id` 一致）。 */
const SURFACE_ID = 'napcat-zcode';

/** 默认 WebUI / OneBot 端口（与 NapCat 官方默认一致）。 */
const DEFAULT_WEBUI_PORT = 6099;
const DEFAULT_ONEBOT_PORT = 3000;

/** 一个受管安装的端口（接管时探测记录的优先，其次它自己的配置，读不到用默认）。 */
function portsOf(install: ManagedInstall): { webuiPort: number; onebotPort: number } {
  let webuiPort = install.webuiPort ?? DEFAULT_WEBUI_PORT;
  let onebotPort = install.onebotPort ?? DEFAULT_ONEBOT_PORT;
  const configDir = join(install.dir, 'napcat', 'config');
  try {
    const webui = JSON.parse(readFileSync(join(configDir, 'webui.json'), 'utf8')) as { port?: number };
    if (Number.isInteger(webui?.port) && (webui?.port ?? 0) > 0) webuiPort = webui!.port!;
  } catch {
    /* 没有就用默认 */
  }
  try {
    const files = readdirSync(configDir) as string[];
    const onebotFile = files.find((f) => f.startsWith('onebot11_') && f.endsWith('.json'));
    if (onebotFile) {
      const cfg = JSON.parse(readFileSync(join(configDir, onebotFile), 'utf8')) as {
        network?: { httpServers?: Array<{ port?: number; enable?: boolean }> };
      };
      const http = cfg.network?.httpServers?.find((s) => s.enable !== false);
      if (Number.isInteger(http?.port) && (http?.port ?? 0) > 0) onebotPort = http!.port!;
    }
  } catch {
    /* 没有就用默认 */
  }
  return { webuiPort, onebotPort };
}

/** 找一条受管安装：给了 id 就按 id，否则取最近登记的一条。 */
function pickInstall(host: ManagedHost, id?: string): ManagedInstall | undefined {
  if (id) return host.get(id);
  const all = host.list();
  return all.length ? all[all.length - 1] : undefined;
}

/**
 * 注册受管宿主的工具。
 *
 * `ManagedHost` 是**单例**（作业在内存里推进，换实例就丢进度）。
 */
export function registerHostTools(server: McpServer, state: AppState): void {
  let host: ManagedHost | undefined;
  const getHost = (): ManagedHost => {
    if (!host) {
      host = new ManagedHost({ dataDir: dataDir(), redact: (text: string) => state.redact(text) });
    }
    return host;
  };

  // ── 在对话里打开面板 ────────────────────────────────────────────────
  server.registerTool(
    'napcat_open_panel',
    {
      description:
        '打开 NapCat 面板：浏览聊天记录、挑选记录注入到对话上下文、导出为附件。' +
        '在对话里调用它会把面板内嵌渲染出来。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: ['app', 'model'] },
        'openai/ui': { preferredModelDisplayMode: 'fullscreen' },
      },
    },
    async () => {
      try {
        return ok({ opened: true, surface: SURFACE_ID });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 状态 ────────────────────────────────────────────────────────────
  server.registerTool(
    'napcat_host_status',
    {
      description:
        '受管宿主状态：插件自己装过的 NapCat（目录、版本、模式）、每个的运行状态' +
        '（运行中 / 已停止 / 降级 / 端口被别的实例占用）、以及最近的安装作业进度。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const h = getHost();
        const installs = h.listViews();
        const probed = await Promise.all(
          installs.map(async (view) => {
            const install = h.get(view.id);
            if (!install) return undefined;
            const ports = portsOf(install);
            return probeManagedHost(install, {
              host: h,
              webuiPort: ports.webuiPort,
              onebotPort: ports.onebotPort,
              probeTimeoutMs: 800,
              desktopQqPath: state.config.managed?.desktopQqPath,
            });
          }),
        );
        const statuses = probed.filter((s): s is HostStatus => s !== undefined);
        return ok({
          installs,
          status: statuses,
          jobs: h.listJobs().map((j) => h.jobView(j)),
          versions: availableVersions(),
        });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 安装 ────────────────────────────────────────────────────────────
  server.registerTool(
    'napcat_install',
    {
      description:
        '下载并安装 NapCat（受管宿主）。**立即返回**一个 jobId，进度用 napcat_install_status 查。' +
        '制品的 sha256 已钉死，校验不过会直接失败并丢弃。',
      inputSchema: {
        dir: z
          .string()
          .optional()
          .describe('安装目录（**绝对路径**）；不传 = 插件数据目录下的 napcat-<版本>'),
        version: z.string().optional().describe('NapCat 版本（默认用配置里的版本）'),
        mode: z
          .enum(['standalone', 'inject'])
          .optional()
          .describe(
            '运行模式：standalone=独立模式（自带内嵌 QQ，不影响桌面 QQ，默认）；' +
              'inject=注入桌面 QQ（QQ 9.9.36+ 有完整性检查，可能报「文件已损坏」）',
          ),
        proxy: z.string().optional().describe('下载代理（如 http://127.0.0.1:7897）；不传 = 用配置里的'),
      },
    },
    async ({ dir, version, mode, proxy }) => {
      try {
        const h = getHost();
        const cfg = state.config;
        const wantVersion = version || cfg.managed?.napcatVersion || '4.18.42';
        const artifact = resolveArtifact(wantVersion);
        if (!artifact) {
          throw new Error(
            `没有可用的 NapCat ${wantVersion} 制品（当前平台只提供 ${availableVersions().join('、')}）。`,
          );
        }
        const targetDir = dir || join(dataDir(), `napcat-${artifact.version}`);
        if (!isAbsolute(targetDir)) {
          throw new Error('安装目录必须是绝对路径：相对路径会随宿主的工作目录变化，无法复现。');
        }
        assertInstallTargetSafe(targetDir, Boolean(h.findByDir(targetDir)));
        const selectedMode = mode ?? 'standalone';
        const request = {
          dir: targetDir,
          version: artifact.version,
          mode: selectedMode,
          url: artifact.url,
          sha256: artifact.sha256,
          allowedHosts: artifact.allowedHosts,
          proxy: proxy || cfg.managed?.downloadProxy || undefined,
          desktopQqRoots: cfg.managed?.desktopQqPath ? [dirname(cfg.managed.desktopQqPath)] : undefined,
        };
        const job: InstallJob = {
          id: newJobId(),
          startedAt: new Date().toISOString(),
          state: 'running',
          phase: 'connecting',
          bytesReceived: 0,
          request,
        };
        h.startInstall(job, request);
        return ok({ jobId: job.id, version: artifact.version, dir: targetDir, mode: selectedMode });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 安装进度 ────────────────────────────────────────────────────────
  server.registerTool(
    'napcat_install_status',
    {
      description: '安装作业的进度与结果（phase / 已下载字节 / 百分比 / 失败原因）。不传 jobId = 最近一次作业。',
      inputSchema: {
        jobId: z.string().optional().describe('作业 id（不传 = 最近一次作业）'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      try {
        const h = getHost();
        const job = jobId ? h.getJob(jobId) : h.listJobs().slice(-1)[0];
        if (!job) {
          return ok({ state: 'none', message: '还没有过安装作业。' });
        }
        return ok(h.jobView(job));
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 启停 ────────────────────────────────────────────────────────────
  server.registerTool(
    'napcat_start',
    {
      description:
        '启动受管 NapCat；启动模式沿用安装时登记的模式，不接受临时覆盖。' +
        '独立模式不影响桌面 QQ；注入模式在 QQ 9.9.36+ 可能触发「文件已损坏」。不传 id = 最近登记的那个。',
      inputSchema: {
        id: z.string().optional().describe('受管安装 id（不传 = 最近登记的一个）'),
      },
    },
    async ({ id }) => {
      try {
        const h = getHost();
        const install = pickInstall(h, id);
        if (!install) {
          throw new Error('还没有受管安装：先用 napcat_install 下载一个。');
        }
        const ports = portsOf(install);
        // 幂等：已经在跑的实例不重复 spawn（面板切页签会反复触发启动）
        const probe = await probeManagedHost(install, {
          host: h,
          webuiPort: ports.webuiPort,
          onebotPort: ports.onebotPort,
          probeTimeoutMs: 800,
          desktopQqPath: state.config.managed?.desktopQqPath,
        });
        if (probe.state === 'running' || probe.state === 'starting') {
          return ok({
            started: false,
            alreadyRunning: true,
            pid: probe.pid,
            mode: install.mode,
            message: '已经在运行了，不用重复启动。',
            webuiPort: ports.webuiPort,
            onebotPort: ports.onebotPort,
          });
        }
        // 端口冲突：另一个 NapCat 实例占着端口（不是本插件启动的）。
        // 不再把用户堵在「停掉别的实例」这一条路上——受管安装可以改自己的配置，
        // 自动换一组空闲端口并启动（各实例端口独立，互不抢）。
        if (probe.state === 'unknown') {
          const remapped = await remapFreePorts(ports);
          h.setPorts(install.id, remapped);
          rewriteNapcatPorts(install.dir, remapped);
          const started = await startManagedHost(
            { ...install, webuiPort: remapped.webuiPort, onebotPort: remapped.onebotPort },
            {
              host: h,
              desktopQqPath: state.config.managed?.desktopQqPath,
            },
          );
          return ok({
            started: true,
            pid: started.pid,
            mode: started.mode,
            remapped: true,
            message:
              `默认端口被占用，已自动改用 WebUI ${remapped.webuiPort} / OneBot ${remapped.onebotPort} 并启动。`,
            warning: started.warning,
            webuiPort: remapped.webuiPort,
            onebotPort: remapped.onebotPort,
          });
        }
        const started = await startManagedHost(install, {
          host: h,
          desktopQqPath: state.config.managed?.desktopQqPath,
        });
        return ok({
          started: true,
          pid: started.pid,
          mode: started.mode,
          message: started.message,
          warning: started.warning,
          webuiPort: ports.webuiPort,
          onebotPort: ports.onebotPort,
        });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_stop',
    {
      description:
        '停止一个受管的 NapCat。只停**本插件自己启动**的进程；' +
        '端口被别的实例占着时会明确告诉你「那不是本插件的进程」，不会去动它。',
      inputSchema: {
        id: z.string().optional().describe('受管安装 id（不传 = 最近登记的那个）'),
      },
    },
    async ({ id }) => {
      try {
        const h = getHost();
        const install = pickInstall(h, id);
        if (!install) {
          throw new Error('还没有受管安装：没有可停止的实例。');
        }
        const ports = portsOf(install);
        const status = await probeManagedHost(install, {
          host: h,
          webuiPort: ports.webuiPort,
          onebotPort: ports.onebotPort,
          probeTimeoutMs: 800,
          desktopQqPath: state.config.managed?.desktopQqPath,
        });
        const result = await stopManagedHost(status, { host: h });
        return ok({ stopped: result.stopped, message: result.message });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 卸载 ────────────────────────────────────────────────────────────
  server.registerTool(
    'napcat_uninstall',
    {
      description:
        '卸载一个受管安装：**删除安装目录**（不可恢复）并清理台账与凭据。' +
        '只接受台账 id（不传 = 最近登记的那个）；目录取自台账登记值，不收任意路径。' +
        '运行中的实例会被拒绝——先用 napcat_stop 停止；目录已不存在时幂等清理台账。',
      inputSchema: {
        id: z.string().optional().describe('受管安装 id（不传 = 最近登记的那个）'),
      },
    },
    async ({ id }) => {
      try {
        const h = getHost();
        const install = pickInstall(h, id);
        if (!install) {
          throw new Error('还没有受管安装：没有可卸载的对象。');
        }
        let killed = 0;
        let r;
        try {
          r = h.uninstall(install.id);
        } catch (firstErr) {
          // 残留进程锁着安装目录（NapCat/QQ 子进程）→ 只结束路径位于目录内的
          // 进程（PowerShell 查询），然后重试一次；其它错误原样抛出
          if (!/EPERM|Permission denied|被占用/i.test(String(firstErr))) throw firstErr;
          killed = await killProcessesUnder(install.dir);
          r = h.uninstall(install.id);
        }
        return ok({
          uninstalled: true,
          id: r.id,
          dir: r.dir,
          alreadyGone: r.alreadyGone,
          kept: r.kept,
          killedProcesses: killed,
          message: r.kept
            ? `已从台账移除（保留你的安装目录）：${r.dir}`
            : r.alreadyGone
              ? `目录已不存在，已从台账清理：${r.dir}`
              : `已删除安装目录并清理台账：${r.dir}`,
        });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 接管检测到的本机安装（0.8.0） ──────────────────────────────────
  server.registerTool(
    'napcat_adopt',
    {
      description:
        '把检测到的本机 NapCat 安装**接管**进受管台账（不重新下载、不改你的配置文件）。' +
        '接管后可用 napcat_start / napcat_stop / napcat_host_status 管理它，' +
        '卸载（napcat_uninstall）只销号、**不删你的目录**。' +
        'configDir 来自 napcat_detect_local 的 installs[].configDir；' +
        '仅支持「NapCat 目录里有 NapCatWinBootMain.exe、同级目录有 QQ.exe」的独立布局（注入式启动）。' +
        '注入模式会触碰桌面 QQ：QQ 9.9.36+ 可能因完整性检查报「文件已损坏」。',
      inputSchema: {
        configDir: z.string().describe('NapCat 的 config 目录（绝对路径，来自 napcat_detect_local）'),
        webuiPort: z.number().int().optional().describe('探测到的 WebUI 端口（记录进台账，供端口推断）'),
      },
    },
    async ({ configDir, webuiPort }) => {
      try {
        const h = getHost();
        if (!isAbsolute(configDir)) {
          throw new Error('接管失败：configDir 必须是绝对路径。');
        }
        const napcatDir = dirname(configDir);
        const bootExe = join(napcatDir, 'NapCatWinBootMain.exe');
        if (!existsSync(bootExe)) {
          throw new Error(
            `接管失败：${napcatDir} 里没有 NapCatWinBootMain.exe。这种安装布局暂不支持接管。`,
          );
        }
        const rootDir = dirname(napcatDir);
        const qqExe = join(rootDir, 'QQ.exe');
        const hasQq = existsSync(qqExe);
        // 版本从 NapCat 的 package.json 读（读不到记 unknown，不影响台账）
        let version = 'unknown';
        try {
          const pkg = JSON.parse(readFileSync(join(napcatDir, 'package.json'), 'utf8')) as { version?: unknown };
          if (typeof pkg.version === 'string' && pkg.version.trim() !== '') version = pkg.version.trim();
        } catch {
          /* 没有 package.json 就记 unknown */
        }
        // QQ 路径记录（QCE 惯例文件）：只在缺失时写，绝不覆盖用户已有记录
        if (hasQq) {
          const qp = join(configDir, 'qq_path.txt');
          if (!existsSync(qp)) {
            try {
              writeFileSync(qp, qqExe, 'utf-8');
            } catch (err) {
              throw new Error(`接管失败：无法写 ${qp}（${err instanceof Error ? err.message : String(err)}）。`);
            }
          }
        }
        const existing = h.findByDir(rootDir);
        if (existing) {
          return ok({
            adopted: true,
            id: existing.id,
            dir: rootDir,
            message: '已在受管台账中。',
          });
        }
        const install: ManagedInstall = {
          id: deriveInstallId(version, rootDir),
          dir: rootDir,
          version,
          mode: 'inject',
          installedAt: new Date().toISOString(),
          artifactSha256: '',
          adopted: true,
          ...(typeof webuiPort === 'number' && webuiPort > 0 ? { webuiPort } : {}),
        };
        h.add(install);
        return ok({
          adopted: true,
          id: install.id,
          dir: rootDir,
          mode: 'inject',
          qqPathFound: hasQq,
          message: hasQq
            ? '已接管，可以启动了。'
            : '已接管。还没找到 QQ，启动前请在插件设置里填写 QQ 路径。',
        });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // ── 扫码登录（0.11.0）：面板轮询拿二维码与状态，WebUI token 不出服务端 ──
  server.registerTool(
    'napcat_qr_login',
    {
      description:
        '获取受管 NapCat 的登录二维码与扫码状态（面板轮询用）。' +
        '返回 phase: waiting（附二维码 data URL）/ accepted（已扫码待确认）/ logined / error。' +
        '若电脑上的桌面 QQ 正登录着同一账号，扫码会被顶号——error 里会说明原因。' +
        '登录成功后会顺带热开启数据通道并把插件自己连上去（connected 字段说明结果）。',
      inputSchema: {
        id: z.string().optional().describe('受管安装 id（不传 = 最近登记的那个）'),
        refresh: z.boolean().optional().describe('true = 重新登录换新二维码（旧的扫码会话作废时用）'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, refresh }) => {
      try {
        const h = getHost();
        const install = pickInstall(h, id);
        if (!install) {
          throw new Error('还没有受管安装：先安装或接管一个 NapCat。');
        }
        const { webuiPort, onebotPort } = portsOf(install);
        const token = h.webuiTokenOf(install.id);
        if (!token) {
          throw new Error('拿不到这个实例的 WebUI 访问令牌。');
        }
        const r = await pollQrLogin((url, init) => fetch(url, init), {
          webuiPort,
          token,
          refresh: refresh === true,
          onebotPort,
        });
        /**
         * 登录成功 → **把插件自己连上去**。
         *
         * 这一步是「扫码成功 → 能看聊天记录」之间**唯一缺失的环节**：
         * 光把 NapCat 的 OneBot 打开没用——插件的连接目标还指着别处（或空），
         * 记录页照样是空的，用户会以为又卡住了。
         *
         * 不覆盖用户已有的可用连接：已经连着就不动它（用户可能自己配了外部端点）。
         */
        if (r.phase === 'logined' && r.onebotEnabled === true && r.onebotEndpoint) {
          const link = await connectToManaged(state, r.onebotEndpoint);
          return ok({ ...r, ...link });
        }
        return ok(r);
      } catch (e) {
        return fail(state, e);
      }
    },
  );
}

/**
 * 把插件的连接目标指向受管实例的 OneBot。
 *
 * - **已经连着** → 什么都不做（别动用户自己的配置）。
 * - **没连着** → 切到受管端点并落盘（下次打开面板还是连它）。
 *   换了端点就清掉旧 token：旧 token 是给旧端点的，带过去会让鉴权失败。
 */
async function connectToManaged(
  state: AppState,
  endpoint: string,
): Promise<{ connected: boolean; connectMessage: string }> {
  try {
    const st = await state.status();
    if (st.connected) {
      return { connected: true, connectMessage: '已连接' };
    }
    const current = state.config.connection.endpoint ?? '';
    const switching = current !== '' && current !== endpoint;
    await state.setConnection(endpoint, '', { clearToken: switching });
    return { connected: true, connectMessage: '已连接，可以看聊天记录了' };
  } catch (e) {
    return {
      connected: false,
      connectMessage: `QQ 登录成功，但插件连不上聊天数据：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// `require` 不用了（统一顶层 import）
