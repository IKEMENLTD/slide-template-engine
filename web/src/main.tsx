import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, yen, type AppState } from './api';
import { Home } from './Home';
import { NewRun } from './NewRun';
import { RunPage } from './RunPage';
import { Settings } from './Settings';
import { IconFolder, IconGear, IconPlus } from './icons';
import { Link, ToastHost, usePath } from './ui';
import { setLang, useLang, useT, type UiLang } from './i18n';
import './styles.css';

function App() {
  const path = usePath();
  const lang = useLang();
  const t = useT();
  const [app, setApp] = useState<AppState | null>(null);
  const refresh = useCallback(() => void api.state().then(setApp).catch(() => {}), []);
  useEffect(refresh, [refresh, path]);
  useEffect(() => {
    document.title = t.appName;
  }, [t]);

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
          <span>{t.appName}</span>
        </Link>
        <nav className="nav" aria-label={t.navMenu}>
          <Link to="/" className={on('/')} title={t.navDecks}>
            <IconFolder />
            <span>{t.navDecks}</span>
          </Link>
          <Link to="/new" className={on('/new')} title={t.navNew}>
            <IconPlus />
            <span>{t.navNew}</span>
          </Link>
          <Link to="/settings" className={on('/settings')} title={t.navSettings}>
            <IconGear />
            <span>{t.navSettings}</span>
          </Link>
        </nav>
        <div className="side-art" aria-hidden="true" />
      </aside>
      <div className="main">
        <div className="topline">
          {app && !app.settings.aiReady && (
            <Link to="/settings" className="badge badge-err">
              {t.keyMissing}
            </Link>
          )}
          {app && (
            <span className="nowrap">
              {t.thisMonth} <b>{yen(app.monthCostUsd, app.usdJpy)}</b>
            </span>
          )}
          <div className="langsw" role="group" aria-label={t.langLabel}>
            {(
              [
                ['ja', '日本語'],
                ['en', 'English'],
              ] as Array<[UiLang, string]>
            ).map(([k, label]) => (
              <button key={k} type="button" lang={k} className={lang === k ? 'on' : ''} aria-pressed={lang === k} onClick={() => setLang(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* 言語を替えたら画面を作り直す（サーバーが作る言葉も、新しい言語で読み直す） */}
        <main key={lang}>{body}</main>
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
