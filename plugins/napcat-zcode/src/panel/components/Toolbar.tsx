/**
 * 工具栏：客户端过滤（关键词 / 发送人 / 时间范围）+ 「含图」占位开关。
 *
 * 过滤都在客户端做：已载入的消息里筛，不额外请求服务端。
 */
export function Toolbar({
  query,
  onQuery,
  senders,
  sender,
  onSender,
  range,
  onRange,
  includeImages,
  onIncludeImages,
}: {
  query: string;
  onQuery: (s: string) => void;
  /** 会话里出现过的发送人（去重后）。 */
  senders: { id: string; name: string }[];
  sender: string;
  onSender: (s: string) => void;
  /** 时间范围：`all` / `today` / `7d` / `30d`。 */
  range: string;
  onRange: (s: string) => void;
  includeImages: boolean;
  onIncludeImages: (v: boolean) => void;
}) {
  return (
    <div className="toolbar">
      <input
        placeholder="关键词过滤…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        data-testid="filter-query"
      />
      <select value={sender} onChange={(e) => onSender(e.target.value)} data-testid="filter-sender">
        <option value="">全部发送人</option>
        {senders.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <select value={range} onChange={(e) => onRange(e.target.value)} data-testid="filter-range">
        <option value="all">全部时间</option>
        <option value="today">今天</option>
        <option value="7d">近 7 天</option>
        <option value="30d">近 30 天</option>
      </select>
      <label
        className="images"
        title="M1 尚未实现媒体下载：这个开关当前不改变任何产物（图片在导出里只是占位符 + URL）"
      >
        <input
          type="checkbox"
          checked={includeImages}
          onChange={(e) => onIncludeImages(e.target.checked)}
          data-testid="filter-images"
          disabled
        />
        含图（M1 暂不下载）
      </label>
    </div>
  );
}
