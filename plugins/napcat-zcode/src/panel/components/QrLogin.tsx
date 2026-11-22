import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * 扫码登录卡：轮询受管实例的 WebUI，把登录二维码直接显示在这里。
 *
 * 状态机：waiting（二维码）→ accepted（已扫码，请确认）→ logined（完成）。
 * 每 2 秒轮询一次；出错显示一句话并可点重试。token 全程留在服务端。
 */
export function QrLogin({ installId, onLogined }: { installId: string; onLogined?: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [phase, setPhase] = useState<'waiting' | 'accepted' | 'logined' | 'error' | 'loading'>('loading');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const loginedRef = useRef(false);

  useEffect(() => {
    alive.current = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await api.qrLogin(installId);
        if (!alive.current || loginedRef.current) return;
        setPhase(r.phase);
        setMessage(r.message);
        if (r.qrDataUrl) setQr(r.qrDataUrl);
        if (r.phase === 'logined') {
          loginedRef.current = true;
          onLogined?.();
        }
      } catch (e) {
        if (!alive.current) return;
        setPhase('error');
        setMessage(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [installId, onLogined]);

  return (
    <div className="qr-login" data-testid="qr-login">
      <div className="qr-frame" data-testid="qr-frame">
        {phase === 'loading' && <div className="qr-hint">正在获取二维码…</div>}
        {qr && <img className="qr-img" src={qr} alt="登录二维码" />}
        {phase === 'accepted' && !qr && <div className="qr-hint">已扫码，请在手机上确认</div>}
        {phase === 'error' && <div className="qr-hint">{message}</div>}
      </div>
      <div className="qr-side">
        <ol className="qr-steps">
          <li className={phase === 'waiting' ? 'now' : ''}>手机 QQ 扫一扫左侧二维码</li>
          <li className={phase === 'accepted' ? 'now' : ''}>在手机上确认登录</li>
          <li className={phase === 'logined' ? 'now' : ''}>登录成功，自动回到这里</li>
        </ol>
        <div className="qr-status">
          {phase === 'logined' ? (
            <span className="qr-ok">登录成功</span>
          ) : (
            <span>{phase === 'accepted' ? '等待手机确认…' : phase === 'waiting' ? '等待扫码…' : message}</span>
          )}
        </div>
      </div>
    </div>
  );
}
