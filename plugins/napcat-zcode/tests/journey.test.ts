/**
 * 首用旅程（面板「记录」页首屏的引导）。
 *
 * 这是新用户看到的第一屏：它必须**只说人话**、**只给一个动作**，
 * 并且如实反映「装没装 / 起没起 / 登没登 / 连上没有」这些已经发生的事实。
 */
import { describe, expect, it } from 'vitest';
import { computeJourney } from '../src/panel/journey.js';
import type { HostStatusResult, StatusInfo } from '../src/panel/api.js';

const INSTALL = {
  id: 'napcat-4.18.42',
  dir: 'D:\\NapCat',
  version: '4.18.42',
  mode: 'standalone' as const,
  installedAt: '2026-11-22T00:00:00.000Z',
  artifactSha256: 'a'.repeat(64),
};

function host(over: Partial<HostStatusResult> = {}): HostStatusResult {
  return {
    installs: [],
    status: [],
    jobs: [],
    versions: ['4.18.42'],
    ...over,
  };
}

function status(over: Partial<StatusInfo> = {}): StatusInfo {
  return { configured: false, connected: false, mode: 'unconfigured', ...over };
}

describe('computeJourney（首用旅程）', () => {
  it('什么都没装 → 第一步是「装好 NapCat」，动作是去安装', () => {
    const j = computeJourney(host(), status());
    expect(j.steps.map((s) => s.key)).toEqual(['prepare', 'login', 'view']);
    expect(j.steps[0].state).toBe('now');
    expect(j.steps[1].state).toBe('todo');
    expect(j.steps[2].state).toBe('todo');
    expect(j.action).toEqual({ kind: 'install', label: '去安装 NapCat' });
  });

  it('装了但没跑 → 第一步变成「启动 NapCat」，动作是启动', () => {
    const j = computeJourney(
      host({
        installs: [INSTALL],
        status: [{ state: 'stopped', install: INSTALL }],
      }),
      status(),
    );
    expect(j.steps[0].title).toBe('启动 NapCat');
    expect(j.steps[0].state).toBe('now');
    expect(j.action?.kind).toBe('start');
  });

  it('跑着但没登录 → 卡在第二步「登录 QQ」，动作是去扫码', () => {
    const j = computeJourney(
      host({
        installs: [INSTALL],
        // OneBot 还没开 → 状态是 degraded（没登录时就是这个状态）
        status: [{ state: 'degraded', install: INSTALL, webuiPort: 6099, onebotPort: 3000 }],
      }),
      status(),
    );
    expect(j.steps[0].state).toBe('done');
    expect(j.steps[1].state).toBe('now');
    expect(j.steps[1].key).toBe('login');
    expect(j.action).toEqual({ kind: 'login', label: '去扫码登录' });
  });

  it('登录了但插件没连上 → 第三步是当前步，动作是重新连接', () => {
    const j = computeJourney(
      host({
        installs: [INSTALL],
        status: [
          {
            state: 'running',
            install: INSTALL,
            login: { user_id: '2350355494', nickname: '小明' },
          },
        ],
      }),
      status(),
    );
    expect(j.steps[1].state).toBe('done');
    expect(j.steps[2].state).toBe('now');
    expect(j.action).toEqual({ kind: 'connect', label: '重新连接' });
  });

  it('连上了 → 三步全完成', () => {
    const j = computeJourney(
      host({
        installs: [INSTALL],
        status: [
          {
            state: 'running',
            install: INSTALL,
            login: { user_id: '2350355494', nickname: '小明' },
          },
        ],
      }),
      status({ configured: true, connected: true, mode: 'external' }),
    );
    expect(j.steps.every((s) => s.state === 'done')).toBe(true);
    expect(j.action).toBeNull();
  });

  it('全程不说内部术语（OneBot / 端点 / token）', () => {
    const j = computeJourney(host(), status());
    const text = j.steps.map((s) => `${s.title} ${s.desc}`).join(' ');
    expect(text).not.toContain('OneBot');
    expect(text).not.toContain('端点');
    expect(text).not.toContain('token');
  });
});
