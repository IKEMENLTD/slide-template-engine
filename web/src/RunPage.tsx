import { useEffect, useState } from 'react';
import { api, minutes, type RunView } from './api';
import { Editor } from './Editor';
import { go, Link, useToast } from './ui';

const STEPS: Array<[string, string]> = [
  ['outline', '原稿を読んで、ページ割りを考える'],
  ['plan', 'ページごとに文章を書き、枠に収まるかを測る'],
  ['photos', '写真を用意する'],
  ['assemble', 'PowerPoint に組み立てる'],
  ['render', 'ページの画像を作る'],
  ['review', 'AI が見た目を確かめる'],
  ['redo', '気になったページを直す'],
  ['check', '最後の検査'],
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
      <div className="card progress-card stack">
        <div>
          <p className="muted small">{run.template}</p>
          <h1>{run.title}</h1>
        </div>
        {run.state === 'queued' && <div className="notice notice-info">順番待ちです（前に {Math.max(0, (run.queuePosition ?? 1) - 1)} 件）。前の資料ができしだい始まります。</div>}
        {!stopped && (
          <>
            <div className="stack-sm">
              <div className="spread">
                <b>{run.stepLabel ?? '準備しています'}</b>
                <b>{run.percent}%</b>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.max(2, run.percent)}%` }} />
              </div>
              <div className="spread small muted">
                <span>経過 {minutes(run.elapsedSeconds)}</span>
                <span>{run.remainingSeconds ? `残り ${minutes(run.remainingSeconds)}（目安）` : ''}</span>
              </div>
            </div>
            <ul className="steps">
              {STEPS.map(([k, label], i) => (
                <li key={k} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
                  <span className="dot">{i < idx ? '✓' : ''}</span>
                  {label}
                  {i === idx && run.detail ? <span className="muted small">（{run.detail}）</span> : null}
                </li>
              ))}
            </ul>
            <div className="notice notice-info">このページを閉じても作成は続きます。できあがると「資料」の一覧に出ます。</div>
          </>
        )}
        {stopped && (
          <>
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
            {log !== null && <pre className="log">{log || '記録はありません'}</pre>}
          </>
        )}
      </div>
    </div>
  );
}
