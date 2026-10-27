import { useEffect, useState } from 'react';
import { api, minutes, type RunView } from './api';
import { Editor } from './Editor';
import { IconBack, IconCheck, IconHistory } from './icons';
import { go, Link, useToast } from './ui';

// 文言は src/app/words.ts の STEP_WORDS と同じ（進み具合の画面で、いまの段がそのまま読めるように）
const STEPS: Array<[string, string]> = [
  ['outline', '原稿を読んで、ページ割りを考えています'],
  ['plan', 'ページごとに文章を書き、枠に収まるかを測っています'],
  ['photos', '写真を用意しています'],
  ['assemble', 'PowerPoint に組み立てています'],
  ['render', 'ページの画像を作っています'],
  ['review', 'AIが見た目を確かめています'],
  ['redo', '気になったページを直しています'],
  ['check', '最後の検査をしています'],
];

export function RunPage({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [run, setRun] = useState<RunView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .run(id)
        .then((r) => {
          if (!alive) return;
          setRun(r);
          setErr(null);
          if (r.state === 'running' || r.state === 'queued') t = setTimeout(load, 2000);
          else document.title = `${r.state === 'done' ? '完成' : '止まりました'}：${r.title} - スライド自動生成`;
        })
        .catch((e: Error) => alive && setErr(e.message));
    void load();
    return () => {
      alive = false;
      clearTimeout(t);
      document.title = 'スライド自動生成';
    };
  }, [id]);

  if (err)
    return (
      <div className="wrap">
        <div className="notice notice-err">{err}</div>
        <p style={{ marginTop: 12 }}>
          <Link to="/">資料の一覧へ戻る</Link>
        </p>
      </div>
    );
  if (!run) return <div className="wrap muted">読み込んでいます…</div>;
  if (run.state === 'done') return <Editor run={run} onRun={(r) => (setRun(r), onChanged())} />;
  return <Progress run={run} />;
}

function Progress({ run }: { run: RunView }) {
  const toast = useToast();
  const [log, setLog] = useState<string | null>(null);
  const idx = STEPS.findIndex(([k]) => k === run.step);
  const stopped = run.state === 'failed' || run.state === 'stopped';

  useEffect(() => {
    if (run.state === 'running') document.title = `${run.percent}% 作成中：${run.title}`;
  }, [run.state, run.percent, run.title]);

  return (
    <div className="wrap">
      <div className="stack-sm" style={{ marginBottom: 22 }}>
        <Link to="/" className="backlink">
          <IconBack />
          資料の一覧へ戻る
        </Link>
        <h1>{run.title}</h1>
        <div>
          <span className="meta-chip">
            {run.slides ? `${run.slides}枚・` : ''}
            {run.template}
          </span>
        </div>
      </div>
      <div className="progress">
        <div className="card progress-card">
          {run.state === 'queued' && (
            <div className="progress-top">
              <div className="notice notice-info">順番待ちです（前に {Math.max(0, (run.queuePosition ?? 1) - 1)} 件）。前の資料ができしだい始まります。</div>
            </div>
          )}
          {!stopped && (
            <>
              <div className="progress-top">
                <div className="pct">
                  <b>
                    {run.percent}
                    <small>%</small>
                  </b>
                  <span>{run.remainingSeconds ? `残り ${minutes(run.remainingSeconds)}` : `経過 ${minutes(run.elapsedSeconds)}`}</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${Math.max(2, run.percent)}%` }} />
                </div>
              </div>
              <ul className="steps">
                {STEPS.map(([k, label], i) => (
                  <li key={k} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
                    <span className="dot">{i < idx ? <IconCheck /> : null}</span>
                    <span>
                      {label}
                      {i === idx && run.detail ? <span className="muted small" style={{ fontWeight: 500 }}>（{run.detail}）</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="progress-foot">
                <span>このページを閉じても作成は続きます。できあがると「資料」の一覧に出ます。</span>
                <button type="button" className="btn" onClick={async () => setLog(log === null ? await api.log(run.id) : null)}>
                  <IconHistory />
                  {log === null ? '途中の記録を見る' : '記録を閉じる'}
                </button>
              </div>
            </>
          )}
          {stopped && (
            <div className="stopped">
              <div className="notice notice-err">
                <b>{run.state === 'failed' ? '作成の途中でうまくいきませんでした。' : '作成が途中で止まりました。'}</b>
                <div>{run.error}</div>
              </div>
              <p>途中までの結果は残っています。「続きから再開」を押すと、止まったところから作り直します（最初からはやり直しません）。</p>
              <div className="row row-wrap">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    try {
                      await api.resume(run.id);
                      location.reload();
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  続きから再開
                </button>
                <button type="button" className="btn" onClick={async () => setLog(await api.log(run.id))}>
                  くわしい記録を見る
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={async () => {
                    if (!confirm('この資料を消します。よろしいですか？')) return;
                    await api.remove(run.id);
                    go('/');
                  }}
                >
                  この資料を消す
                </button>
              </div>
            </div>
          )}
          {log !== null && <pre className="log">{log || '記録はありません'}</pre>}
        </div>
        <div className="art-panel" aria-hidden="true">
          <img src="/art/slides.jpg" alt="" />
        </div>
      </div>
    </div>
  );
}
