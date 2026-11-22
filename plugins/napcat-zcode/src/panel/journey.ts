import type { HostStatus, HostStatusResult, StatusInfo } from './api.js';

/**
 * 首用旅程：把「我想看 QQ 聊天记录」拆成用户能认的三步。
 *
 * **为什么要有它**：面板原先的组织方式是按**内部概念**分的
 * （NapCat 管理页 / OneBot 端点 / token），新用户打开「记录」页看到的是
 * 一张要自己填地址和 token 的表单——他知道要看聊天记录，但不知道第一步该点哪。
 *
 * 这里反过来：**按用户的任务组织**，每一步一个动作、当前步高亮，
 * 其余步骤灰着（不许乱点）。术语一律不出现（不说 OneBot、不说端点）。
 */
export type JourneyKey = 'prepare' | 'login' | 'view';
export type JourneyState = 'done' | 'now' | 'todo';

export interface JourneyStep {
  key: JourneyKey;
  title: string;
  /** 这步要做什么（一句话，用户语言）。 */
  desc: string;
  state: JourneyState;
}

/** 当前步的唯一主动作。面板据此渲染一个按钮——永远只有一个主动作。 */
export type JourneyAction =
  | { kind: 'install'; label: string }
  | { kind: 'start'; label: string; installId?: string }
  | { kind: 'login'; label: string }
  | { kind: 'connect'; label: string };

export interface Journey {
  steps: JourneyStep[];
  current: JourneyKey;
  action: JourneyAction | null;
}

/** 受管实例是否「活着」（跑着或正在起来）。 */
function isLive(s: HostStatus): boolean {
  return s.state === 'running' || s.state === 'starting' || s.state === 'degraded';
}

/**
 * 算出用户现在走到哪一步了。
 *
 * 判定只用**已经发生过的事实**（装没装、在不在跑、登录了没、插件连上没），
 * 不用「推测下一步会怎样」——推测出来的进度条会骗人。
 */
export function computeJourney(
  host: HostStatusResult | null,
  status: StatusInfo | null,
): Journey {
  const installs = host?.installs ?? [];
  const statuses = host?.status ?? [];
  const live = statuses.filter(isLive);
  const running = statuses.find((s) => s.state === 'running');
  /** 装没装（台账里有登记就算装了）。 */
  const installed = installs.length > 0;
  /** 跑着没。 */
  const alive = live.length > 0;
  /**
   * 登录了没。
   *
   * 两个来源：受管实例探到登录信息（state==='running' 时才有），或插件自己连上了。
   * `degraded`（OneBot 没开）探不到登录信息 → 只能算「还不知道」。
   */
  const loggedIn = running?.login !== undefined || status?.connected === true;

  const steps: JourneyStep[] = [];

  // ① 准备
  if (!installed) {
    steps.push({
      key: 'prepare',
      title: '装好 NapCat',
      desc: '在你电脑上装一个读取 QQ 聊天记录的小工具（约 100 MB，装完自动启动）',
      state: 'now',
    });
  } else if (!alive) {
    steps.push({
      key: 'prepare',
      title: '启动 NapCat',
      desc: '已经装好了，启动它才能读取聊天记录',
      state: 'now',
    });
  } else {
    steps.push({ key: 'prepare', title: '装好 NapCat', desc: '已安装并在运行', state: 'done' });
  }

  // ② 登录
  if (loggedIn) {
    steps.push({ key: 'login', title: '登录 QQ', desc: '已登录', state: 'done' });
  } else if (alive) {
    steps.push({
      key: 'login',
      title: '登录 QQ',
      desc: '用手机 QQ 扫一下二维码，确认后就能读到聊天记录',
      state: 'now',
    });
  } else {
    steps.push({ key: 'login', title: '登录 QQ', desc: '扫码登录你的 QQ 账号', state: 'todo' });
  }

  // ③ 查看
  if (status?.connected === true) {
    steps.push({ key: 'view', title: '查看聊天记录', desc: '已连接，去左边挑一个会话', state: 'done' });
  } else if (loggedIn) {
    steps.push({
      key: 'view',
      title: '查看聊天记录',
      desc: '正在连接聊天记录……',
      state: 'now',
    });
  } else {
    steps.push({ key: 'view', title: '查看聊天记录', desc: '连上之后就能挑会话看消息', state: 'todo' });
  }

  // 当前步 = 第一个非 done 的步骤（都 done 了就是终点，没有主动作）
  const now = steps.find((s) => s.state === 'now');
  const current = now?.key ?? 'view';

  let action: JourneyAction | null = null;
  if (current === 'prepare' && now) {
    action = installed
      ? { kind: 'start', label: '启动 NapCat', installId: live[0]?.install?.id ?? installs[0]?.id }
      : { kind: 'install', label: '去安装 NapCat' };
  } else if (current === 'login' && now) {
    action = { kind: 'login', label: '去扫码登录' };
  } else if (current === 'view' && now) {
    action = { kind: 'connect', label: '重新连接' };
  }

  return { steps, current, action };
}
