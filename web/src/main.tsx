import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, yen, type AppState } from './api';
import { Home } from './Home';
import { NewRun } from './NewRun';
import { RunPage } from './RunPage';
import { Settings } from './Settings';
import { IconFolder, IconGear, IconPlus } from './icons';
import { Link, ToastHost, usePath } from './ui';
import './styles.css';

function App() {
  const path = usePath();
  const [app, setApp] = useState<AppState | null>(null);
  const refresh = useCallback(() => void api.state().then(setApp).catch(() => {}), []);
  useEffect(refresh, [refresh, path]);

  const run = path.match(/^\/runs\/([\w.-]+)$/);
  let body;
  if (path === '/new') body = <NewRun app={app} />;
  else if (path === '/settings') body = <Settings app={app} onSaved={refresh} />;
  else if (run) body = <RunPage key={run[1]} id={run[1]} onChanged={refresh} />;
  else body = <Home />;

  const on = (p: string) => (p === '/' ? path === '/' || !!run : path === p) ? 'on' : '';
  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>スライド自動生成</span>
        </Link>
        <nav className="nav" aria-label="メニュー">
          <Link to="/" className={on('/')} title="資料">
            <IconFolder />
            <span>資料</span>
          </Link>
          <Link to="/new" className={on('/new')} title="新しく作る">
            <IconPlus />
            <span>新しく作る</span>
          </Link>
          <Link to="/settings" className={on('/settings')} title="設定">
            <IconGear />
            <span>設定</span>
          </Link>
        </nav>
        <div className="side-art" aria-hidden="true" />
      </aside>
      <div className="main">
        <div className="topline">
          {app && !app.settings.aiReady && (
            <Link to="/settings" className="badge badge-err">
              鍵が未設定
            </Link>
          )}
          {app && (
            <span className="nowrap">
              今月 <b>{yen(app.monthCostUsd, app.usdJpy)}</b>
            </span>
          )}
        </div>
        <main>{body}</main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>
);
