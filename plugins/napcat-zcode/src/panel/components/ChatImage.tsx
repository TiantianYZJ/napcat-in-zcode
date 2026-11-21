import { useEffect, useRef, useState } from 'react';
import { readImage } from '../api.js';

/**
 * 聊天里的图片段：经服务端代理资源拉图（CSP 的 `img-src` 不放行外域，
 * 面板拿的是 `readServerResource` 返回的 `data:` URL），加载失败时回退成占位符。
 *
 * 生命周期：占位框 → 加载中 → 图片 / 失败占位。失败是**常态**要考虑的路径
 * （图片过期、外网不通、宿主不支持资源读取），不能让一条破图毁掉整段消息流。
 */
export function ChatImage({ url }: { url: string }) {
  // 缓存在 api 层；这里只管单个 URL 的生命周期
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    readImage(url)
      .then((dataUrl) => {
        if (alive.current) setSrc(dataUrl);
      })
      .catch((e: unknown) => {
        if (alive.current) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive.current = false;
    };
  }, [url]);

  if (src) {
    return (
      <img
        className="msg-img"
        src={src}
        alt="聊天图片"
        data-testid="msg-image"
        loading="lazy"
        // 点击在新标签页看原图（data URL 在沙箱里通常被拦，失败无害）
        onClick={() => {
          const w = window.open(src, '_blank');
          void w;
        }}
      />
    );
  }
  if (failed) {
    return (
      <div className="msg-img-fallback" data-testid="msg-image-failed" title={failed}>
        图片未能加载
      </div>
    );
  }
  return (
    <div className="msg-img-loading" data-testid="msg-image-loading">
      图片加载中…
    </div>
  );
}
