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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dataDir } from '../config.js';
import { fail, ok } from '../tool-results.js';
import type { AppState } from '../state.js';
import { availableVersions, resolveArtifact } from './artifacts.js';
import { ManagedHost, newJobId, type InstallJob, type ManagedInstall } from './manager.js';
import { probeManagedHost, startManagedHost, stopManagedHost, type HostStatus } from './supervise.js';

/** 面板资源 URI（必须与清单 `ui.surfaces[0].resourceUri` 一致）。 */
const PANEL_URI = 'ui://napcat-zcode/panel.html';
/** 面板 surface id（必须与清单 `ui.surfaces[0].id` 一致）。 */
const SURFACE_ID = 'napcat-zcode';

/** 默认 WebUI / OneBot 端口（与 NapCat 官方默认一致）。 */
const DEFAULT_WEBUI_PORT = 6099;
const DEFAULT_ONEBOT_PORT = 3000;

/** 一个受管安装的端口（从它自己的配置里读，读不到用默认）。 */
function portsOf(install: ManagedInstall): { webuiPort: number; onebotPort: number } {
  let webuiPort = DEFAULT_WEBUI_PORT;
  let onebotPort = DEFAULT_ONEBOT_PORT;
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
        if (existsSync(join(targetDir, 'node.exe')) && h.findByDir(targetDir)) {
          // 同一目录已在册 → 允许覆盖安装（作业内部会先备份旧目录，失败会换回来）
        }
        const request = {
          dir: targetDir,
          version: artifact.version,
          mode: mode ?? 'standalone',
          url: artifact.url,
          sha256: artifact.sha256,
          allowedHosts: artifact.allowedHosts,
          proxy: proxy || cfg.managed?.downloadProxy || undefined,
          desktopQqRoots: cfg.managed?.desktopQqPath ? [cfg.managed.desktopQqPath] : undefined,
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
        return ok({ jobId: job.id, version: artifact.version, dir: targetDir, mode: request.mode });
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
        '启动一个受管的 NapCat（独立模式 = 自带内嵌 QQ，不影响桌面 QQ；注入模式会注入桌面 QQ，' +
        'QQ 9.9.36+ 可能因此报「文件已损坏」）。不传 id = 最近登记的那个。',
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
}

// `require` 不用了（统一顶层 import）
