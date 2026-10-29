import { useEffect, useState } from 'react';
import { api, dateText, type RunView } from './api';
import { IconAlert, IconCheckCircle, IconDoc } from './icons';
import { Link } from './ui';
import { useT } from './i18n';

type Item = Omit<RunView, 'issues'>;

export function StateBadge({ r, large }: { r: Pick<RunView, 'state' | 'percent' | 'errors' | 'warnings' | 'queuePosition'>; large?: boolean }) {
  const t = useT();
  const lg = large ? ' badge-lg' : '';
  if (r.state === 'running') return <span className={`badge badge-run${lg}`}>{t.badgeRunning(r.percent)}</span>;
  if (r.state === 'queued') return <span className={`badge badge-run${lg}`}>{t.badgeQueued}</span>;
  if (r.state === 'failed')
    return (
      <span className={`badge badge-err${lg}`}>
        {large && <IconAlert />}
        {t.badgeFailed}
      </span>
    );
  if (r.state === 'stopped')
    return (
      <span className={`badge badge-err${lg}`}>
        {large && <IconAlert />}
        {t.badgeStopped}
      </span>
    );
  if (r.errors) return <span className={`badge badge-err${lg}`}>{t.badgeErrors(r.errors)}</span>;
  if (r.warnings)
    return (
      <span className={`badge badge-ok${lg}`}>
        {large && <IconCheckCircle />}
        {t.badgeDoneWarn(r.warnings)}
      </span>
    );
  return (
    <span className={`badge badge-ok${lg}`}>
      {large && <IconCheckCircle />}
      {t.badgeDone}
    </span>
  );
}

export function Home() {
  const t = useT();
  const [runs, setRuns] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .runs()
        .then((r) => alive && (setRuns(r), setErr(null)))
        .catch((e: Error) => alive && setErr(e.message));
    load();
    // 作成中のものがあれば、進み具合を更新する
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <h1>{t.homeTitle}</h1>
          <p className="muted">{t.homeLead}</p>
        </div>
        <Link to="/new" className="btn btn-primary btn-lg">
          {t.newDeckBtn}
        </Link>
      </div>
      {err && <div className="notice notice-err">{err}</div>}
      {runs && runs.length === 0 && <Empty />}
      {runs && runs.length > 0 && (
        <div className="runs">
          {runs.map((r) => (
            <Link key={r.id} to={`/runs/${r.id}`} className="card run-card">
              <div className="run-thumb">{r.cover ? <img src={r.cover} alt="" loading="lazy" /> : <span className="muted small">{r.state === 'done' ? '' : t.creating}</span>}</div>
              <div className="run-body">
                <div className="run-title">{r.title}</div>
                <StateBadge r={r} large />
                {(r.state === 'running' || r.state === 'queued') && (
                  <div className="mini-bar">
                    <i style={{ width: `${Math.max(3, r.percent)}%` }} />
                  </div>
                )}
              </div>
              <div className="run-meta">
                <IconDoc />
                <span className="nowrap">
                  {r.slides ? t.slidesPrefix(r.slides) : ''}
                  {dateText(r.createdAt)}
                </span>
              </div>
            </Link>
          ))}
          <Link to="/new" className="card new-card">
            <span className="plus">＋</span>
            {t.newDeckCard}
          </Link>
        </div>
      )}
    </div>
  );
}

function Empty() {
  const t = useT();
  return (
    <div className="empty">
      <div className="card card-pad stack">
        <h2>{t.emptyTitle}</h2>
        <p className="muted">{t.emptyLead}</p>
        <div className="empty-steps">
          <div className="empty-step">
            <b>{t.emptyStep1}</b>
            {t.emptyStep1Body}
          </div>
          <div className="empty-step">
            <b>{t.emptyStep2}</b>
            {t.emptyStep2Body}
          </div>
          <div className="empty-step">
            <b>{t.emptyStep3}</b>
            {t.emptyStep3Body}
          </div>
        </div>
        <div>
          <Link to="/new" className="btn btn-primary btn-lg">
            {t.emptyCta}
          </Link>
        </div>
      </div>
      <div className="art-panel" aria-hidden="true">
        <img src="/art/slides.jpg" alt="" />
      </div>
    </div>
  );
}
