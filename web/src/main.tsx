import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, yen, type AppState } from './api';
import { Home } from './Home';
import { NewRun } from './NewRun';
import { RunPage } from './RunPage';
import { Settings } from './Settings';
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
    <>
      <header className="topbar">
        <div className="topbar-in">
          <Link to="/" className="brand">
            <span className="brand-mark" />
            <span>スライド自動生成</span>
          </Link>
          <nav className="nav">
            <Link to="/" className={on('/')}>
              資料
            </Link>
            <Link to="/new" className={on('/new')}>
              新しく作る
            </Link>
            <Link to="/settings" className={on('/settings')}>
              設定
            </Link>
          </nav>
          <div className="topbar-right small">
            {app && !app.settings.aiReady && (
              <Link to="/settings" className="badge badge-err">
                鍵が未設定
              </Link>
            )}
            {app && <span className="muted nowrap">今月 {yen(app.monthCostUsd, app.usdJpy)}</span>}
          </div>
        </div>
      </header>
      <main>{body}</main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>
);
