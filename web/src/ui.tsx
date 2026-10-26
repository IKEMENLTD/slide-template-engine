/** 画面の共通部品：小さな道案内（URL と画面の対応）・知らせ */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ---- 道案内（ブラウザの「戻る」も効く）
export function usePath(): string {
  const [p, setP] = useState(location.pathname);
  useEffect(() => {
    const on = () => setP(location.pathname);
    addEventListener('popstate', on);
    addEventListener('app:navigate', on);
    return () => {
      removeEventListener('popstate', on);
      removeEventListener('app:navigate', on);
    };
  }, []);
  return p;
}

export function go(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  scrollTo(0, 0);
  dispatchEvent(new Event('app:navigate'));
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

// ---- 知らせ
type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, error }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), error ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' toast-err' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** 経過秒を数える（時間のかかる操作の間に出す） */
export function useElapsed(running: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return setS(0);
    const t0 = Date.now();
    const t = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);
  return s;
}
