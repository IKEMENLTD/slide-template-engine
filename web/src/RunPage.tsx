import { useEffect, useState } from 'react';
import { api, minutes, type RunView } from './api';
import { Editor } from './Editor';
import { IconBack, IconCheck, IconHistory } from './icons';
import { go, Link, useToast } from './ui';
import { tNow, useT } from './i18n';

// 段の並び（言葉は i18n.ts の steps。サーバーの src/app/words.ts の STEP_WORDS と同じ文言）
const STEPS = ['outline', 'plan', 'photos', 'assemble', 'render', 'review', 'redo', 'check'] as const;

export function RunPage({ id, onChanged }: { id: string; onChanged: () => void }) {
  const t = useT();
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
          else {
            const w = tNow();
            document.title = w.docTitleRun(r.state === 'done' ? w.runDone : w.runStopped, r.title, w.appName);
          }
        })
        .catch((e: Error) => alive && setErr(e.message));
    void load();
    return () => {
      alive = false;
      clearTimeout(t);
      document.title = tNow().appName;
    };
  }, [id]);

  if (err)
    return (
      <div className="wrap">
        <div className="notice notice-err">{err}</div>
        <p style={{ marginTop: 12 }}>
          <Link to="/">{t.backToList}</Link>
        </p>
      </div>
    );
  if (!run) return <div className="wrap muted">{t.loading}</div>;
  if (run.state === 'done') return <Editor run={run} onRun={(r) => (setRun(r), onChanged())} />;
  return <Progress run={run} />;
}

function Progress({ run }: { run: RunView }) {
  const toast = useToast();
  const t = useT();
  const [log, setLog] = useState<string | null>(null);
  const idx = STEPS.findIndex((k) => k === run.step);
  const stopped = run.state === 'failed' || run.state === 'stopped';

  useEffect(() => {
    if (run.state === 'running') document.title = t.docTitleProgress(run.percent, run.title);
  }, [run.state, run.percent, run.title, t]);

  return (
    <div className="wrap">
      <div className="stack-sm" style={{ marginBottom: 22 }}>
        <Link to="/" className="backlink">
          <IconBack />
          {t.backToList}
        </Link>
        <h1>{run.title}</h1>
        <div>
          <span className="meta-chip">
            {run.slides ? t.slidesPrefix(run.slides) : ''}
            {run.template}
          </span>
        </div>
      </div>
      <div className="progress">
        <div className="card progress-card">
          {run.state === 'queued' && (
            <div className="progress-top">
              <div className="notice notice-info">{t.queuedNotice(Math.max(0, (run.queuePosition ?? 1) - 1))}</div>
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
                  <span>{run.remainingSeconds ? t.remaining(minutes(run.remainingSeconds)) : t.elapsed(minutes(run.elapsedSeconds))}</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${Math.max(2, run.percent)}%` }} />
                </div>
              </div>
              <ul className="steps">
                {STEPS.map((k, i) => (
                  <li key={k} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
                    <span className="dot">{i < idx ? <IconCheck /> : null}</span>
                    <span>
                      {t.steps[k]}
                      {i === idx && run.detail ? <span className="muted small" style={{ fontWeight: 500 }}>{t.paren(run.detail)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="progress-foot">
                <span>{t.progressFoot}</span>
                <button type="button" className="btn" onClick={async () => setLog(log === null ? await api.log(run.id) : null)}>
                  <IconHistory />
                  {log === null ? t.showLog : t.hideLog}
                </button>
              </div>
            </>
          )}
          {stopped && (
            <div className="stopped">
              <div className="notice notice-err">
                <b>{run.state === 'failed' ? t.failedHead : t.stoppedHead}</b>
                <div>{run.error}</div>
              </div>
              <p>{t.resumeHint}</p>
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
                  {t.resume}
                </button>
                <button type="button" className="btn" onClick={async () => setLog(await api.log(run.id))}>
                  {t.showFullLog}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={async () => {
                    if (!confirm(t.deleteConfirm)) return;
                    await api.remove(run.id);
                    go('/');
                  }}
                >
                  {t.deleteDeck}
                </button>
              </div>
            </div>
          )}
          {log !== null && <pre className="log">{log || t.noLog}</pre>}
        </div>
        <div className="art-panel" aria-hidden="true">
          <img src="/art/slides.jpg" alt="" />
        </div>
      </div>
    </div>
  );
}
