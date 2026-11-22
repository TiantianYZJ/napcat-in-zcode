/** 扫码登录的可注入 fetch 形状（POST JSON；测试用，避免真实联网）。 */
export type QrFetcher = (
  url: string,
  init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;
