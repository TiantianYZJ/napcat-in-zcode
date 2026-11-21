/**
 * 工具层共用的返回值封装。
 *
 * 单独成模块：`tools.ts` 与 `host-tools.ts` 都要用，
 * 放在这里避免它们互相 import（循环依赖在 ESM 里能跑，但没必要冒这个险）。
 */

import type { AppState } from './state.js';

/** 成功返回：内容是 JSON 文本。 */
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/**
 * 失败返回：`isError: true` + `{error: string}`。
 *
 * 工具层不向外抛异常——错误信息经 `state.redact` 脱敏（token 不许出现在返回值里）。
 */
export function fail(state: AppState, e: unknown) {
  const message = state.redact(e instanceof Error ? e.message : String(e));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
