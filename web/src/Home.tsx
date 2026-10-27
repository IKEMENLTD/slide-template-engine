import { useEffect, useState } from 'react';
import { api, dateText, type RunView } from './api';
import { IconAlert, IconCheckCircle, IconDoc } from './icons';
import { Link } from './ui';

type Item = Omit<RunView, 'issues'>;

export function StateBadge({ r, large }: { r: Pick<RunView, 'state' | 'percent' | 'errors' | 'warnings' | 'queuePosition'>; large?: boolean }) {
  const lg = large ? ' badge-lg' : '';
  if (r.state === 'running') return <span className={`badge badge-run${lg}`}>作成中 {r.percent}%</span>;
  if (r.state === 'queued') return <span className={`badge badge-run${lg}`}>順番待ち</span>;
  if (r.state === 'failed')
    return (
      <span className={`badge badge-err${lg}`}>
        {large && <IconAlert />}作成できませんでした
      </span>
    );
  if (r.state === 'stopped')
    return (
      <span className={`badge badge-err${lg}`}>
        {large && <IconAlert />}途中で止まりました
      </span>
    );
  if (r.errors) return <span className={`badge badge-err${lg}`}>直すところ {r.errors}</span>;
  if (r.warnings)
    return (
      <span className={`badge badge-ok${lg}`}>
        {large && <IconCheckCircle />}完成・確認 {r.warnings}
      </span>
    );
  return (
    <span className={`badge badge-ok${lg}`}>
      {large && <IconCheckCircle />}完成
    </span>
  );
}

export function Home() {
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
          <h1>資料</h1>
          <p className="muted">原稿を入れると、テンプレートに沿ったスライドを自動で作ります。</p>
        </div>
        <Link to="/new" className="btn btn-primary btn-lg">
          ＋ 新しく資料を作る
        </Link>
      </div>
      {err && <div className="notice notice-err">{err}</div>}
      {runs && runs.length === 0 && <Empty />}
      {runs && runs.length > 0 && (
        <div className="runs">
          {runs.map((r) => (
            <Link key={r.id} to={`/runs/${r.id}`} className="card run-card">
              <div className="run-thumb">{r.cover ? <img src={r.cover} alt="" loading="lazy" /> : <span className="muted small">{r.state === 'done' ? '' : '作成中'}</span>}</div>
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
                  {r.slides ? `${r.slides}枚・` : ''}
                  {dateText(r.createdAt)}
                </span>
              </div>
            </Link>
          ))}
          <Link to="/new" className="card new-card">
            <span className="plus">＋</span>
            新しく資料を作る
          </Link>
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <div className="card card-pad stack">
        <h2>まだ資料がありません</h2>
        <p className="muted">3つの手順で資料ができます。</p>
        <div className="empty-steps">
          <div className="empty-step">
            <b>1. 原稿を入れる</b>
            伝えたいことを文章で書くか、Word のファイルを読み込みます。
          </div>
          <div className="empty-step">
            <b>2. 待つ（5〜10分）</b>
            AI がページ割り・文章・写真を用意し、テンプレートに流し込みます。
          </div>
          <div className="empty-step">
            <b>3. 直してダウンロード</b>
            気になるページだけ直して、PowerPoint か PDF で受け取ります。
          </div>
        </div>
        <div>
          <Link to="/new" className="btn btn-primary btn-lg">
            最初の資料を作る
          </Link>
        </div>
      </div>
      <div className="art-panel" aria-hidden="true">
        <img src="/art/slides.jpg" alt="" />
      </div>
    </div>
  );
}
