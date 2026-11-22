import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * 扫码登录卡：轮询受管实例的 WebUI，把登录二维码直接显示在这里。
 *
 * 右侧是**步进条**（圆点 + 进度线）：把「退出桌面 QQ → 扫码 → 手机确认 → 登录成功」
 * 画成一条有状态的进度线，用户一眼知道自己在第几步、还差什么。
 *
 * 关键引导（QQ 同号只能登录一处）：电脑上的桌面 QQ 若还登着同一账号，
 * 扫码会被顶号、登录不上去——所以第一步就是「先退出电脑 QQ 上的同一账号」，
 * 并且检测到桌面 QQ 正在跑时明确提醒。
 */
export function QrLogin({
  installId,
  onLogined,
  onOpenRecords,
}: {
  installId: string;
  onLogined?: () => void;
  /** 登录成功后的出口：去记录页看聊天记录。 */
  onOpenRecords?: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [phase, setPhase] = useState<'waiting' | 'accepted' | 'logined' | 'error' | 'loading'>('loading');
  const [message, setMessage] = useState('');
  const [desktopQq, setDesktopQq] = useState(false);
  const [onebotEnabled, setOnebotEnabled] = useState<boolean | undefined>(undefined);
  const [onebotMessage, setOnebotMessage] = useState('');
  const alive = useRef(true);
  const loginedRef = useRef(false);

  useEffect(() => {
    alive.current = true;
    const tick = async (refresh = false): Promise<void> => {
      try {
        const r = await api.qrLogin(installId, refresh);
        if (!alive.current || loginedRef.current) return;
        setPhase(r.phase);
        setMessage(r.message);
        if (r.qrDataUrl) setQr(r.qrDataUrl);
        if (r.desktopQqRunning !== undefined) setDesktopQq(r.desktopQqRunning);
        if (r.onebotEnabled !== undefined) setOnebotEnabled(r.onebotEnabled);
        if (r.onebotMessage !== undefined) setOnebotMessage(r.onebotMessage);
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

  // 步进条：算出当前处在第几步
  const step = (() => {
    if (phase === 'logined') return 3;
    if (phase === 'accepted') return 2;
    if (phase === 'error') return desktopQq ? 0 : 1;
    return desktopQq ? 0 : 1; // waiting：桌面 QQ 还占着号 → 第 0 步，否则第 1 步
  })();
  const steps = ['先退出电脑 QQ 上的同一账号', '用手机 QQ 扫一扫左侧二维码', '在手机上确认登录', '登录成功'];

  return (
    <div className="qr-login" data-testid="qr-login">
      <div className="qr-frame" data-testid="qr-frame">
        {phase === 'loading' && <div className="qr-hint">正在获取二维码…</div>}
        {qr && phase !== 'error' && <img className="qr-img" src={qr} alt="登录二维码" />}
        {phase === 'accepted' && !qr && <div className="qr-hint">已扫码，请在手机上确认</div>}
        {phase === 'error' && <div className="qr-hint">{message}</div>}
      </div>
      <div className="qr-side">
        <ol className="qr-steps" data-testid="qr-steps">
          {steps.map((label, i) => {
            const state = i < step ? 'done' : i === step ? 'now' : 'todo';
            return (
              <li key={label} className={state} data-testid={`qr-step-${i}`} data-state={state}>
                <span className="qr-dot" aria-hidden="true" />
                <span className="qr-step-label">{label}</span>
              </li>
            );
          })}
        </ol>
        {desktopQq && phase !== 'logined' && (
          <div className="qr-warn" data-testid="qr-desktop-warning">
            检测到电脑 QQ 正在运行。同一账号不能登录两处，请先退出桌面 QQ 再扫。
          </div>
        )}
        {phase === 'logined' && onebotEnabled === true && (
          <div className="qr-ok-note" data-testid="qr-onebot-ok">
            OneBot 已开启，现在可以去浏览聊天记录了。
          </div>
        )}
        {phase === 'logined' && onebotMessage && (
          <div className="qr-warn" data-testid="qr-onebot-warn">
            {onebotMessage}
          </div>
        )}
        <div className="qr-status">
          {phase === 'logined' ? (
            <span className="qr-ok">登录成功</span>
          ) : (
            <span>{phase === 'accepted' ? '等待手机确认…' : phase === 'waiting' ? '等待扫码…' : message}</span>
          )}
        </div>
        <div className="qr-acts">
          {phase === 'logined' && onOpenRecords && (
            <button className="btn primary" data-testid="qr-open-records" onClick={onOpenRecords}>
              去看聊天记录
            </button>
          )}
          {phase === 'error' && (
            <button
              className="btn"
              data-testid="qr-refresh"
              onClick={() => {
                setQr(null);
                setPhase('loading');
                setMessage('');
                void api.qrLogin(installId, true).catch(() => undefined);
              }}
            >
              重新获取二维码
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
