import { IconAlert, IconBack, IconDoc, IconDocCheck, IconDownload, IconNext, IconNote, IconShield, IconUndo } from './icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, langHeader, type Fit, type Issue, type PageView, type RunView, type TypeChoice } from './api';
import { Link, useElapsed, useToast } from './ui';
import { useLang, useT } from './i18n';

type Tab = 'text' | 'ai' | 'type' | 'photo';
type Busy = { label: string; about: string };

export function Editor({ run, onRun }: { run: RunView; onRun: (r: RunView) => void }) {
  const toast = useToast();
  const t = useT();
  const uiLang = useLang();
  const [pages, setPages] = useState<PageView[] | null>(null);
  const [cur, setCur] = useState(() => Number(new URLSearchParams(location.search).get('p')) || 1);
  const [tab, setTab] = useState<Tab>('text');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fits, setFits] = useState<Record<string, Fit>>({});
  const [draftIssues, setDraftIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [instruction, setInstruction] = useState('');
  const [types, setTypes] = useState<TypeChoice[] | null>(null);
  const [tplTypes, setTplTypes] = useState<Record<string, string | null>>({});
  const lastFocus = useRef<HTMLTextAreaElement | null>(null);
  const elapsed = useElapsed(!!busy);

  const page = pages?.[cur - 1];
  const dirty = !!page && page.slots.some((s) => (draft[s.name] ?? s.text) !== s.text);

  useEffect(() => {
    api.pages(run.id).then(setPages).catch((e: Error) => toast(e.message, true));
    // ページの形の見本の画像（テンプレートの見本を使う）
    api
      .templates()
      .then((ts) => {
        const tp = ts.find((x) => x.id === run.templateId) ?? ts.find((x) => x.name === run.template) ?? ts[0];
        setTplTypes(Object.fromEntries((tp?.types ?? []).map((x) => [x.key, x.image])));
      })
      .catch(() => {});
  }, [run.id, run.template, run.templateId, toast]);

  // ページを移ったら、書きかけを捨てて、そのページの文言を入れる
  useEffect(() => {
    if (!page) return;
    setDraft(Object.fromEntries(page.slots.map((s) => [s.name, s.text])));
    setFits({});
    setDraftIssues(null);
    setTypes(null);
    const u = new URL(location.href);
    u.searchParams.set('p', String(cur));
    history.replaceState(null, '', u);
  }, [cur, page]);

  // 打ちながら測る
  useEffect(() => {
    if (!page || !dirty) {
      setFits({});
      setDraftIssues(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .check(run.id, cur, draft)
        .then((r) => (setFits(r.fits), setDraftIssues(r.issues)))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, dirty, page, cur, run.id]);

  useEffect(() => {
    if (tab === 'type' && !types && page) api.types(run.id, cur).then(setTypes).catch((e: Error) => toast(e.message, true));
  }, [tab, types, page, run.id, cur, toast]);

  const move = useCallback(
    (n: number) => {
      if (!pages || n < 1 || n > pages.length || n === cur) return;
      if (dirty && !confirm(t.discardDraft)) return;
      setCur(n);
    },
    [pages, cur, dirty, t]
  );

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (busy || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (e.preventDefault(), move(cur - 1));
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (e.preventDefault(), move(cur + 1));
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [cur, move, busy]);

  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (dirty || busy) e.preventDefault();
    };
    addEventListener('beforeunload', on);
    return () => removeEventListener('beforeunload', on);
  }, [dirty, busy]);

  /** 時間のかかる直しを行い、そのページと資料の状態を取り直す */
  async function act(b: Busy, fn: () => Promise<{ page: PageView }>, done: string) {
    setBusy(b);
    try {
      const r = await fn();
      setPages((ps) => ps && ps.map((p) => (p.n === r.page.n ? r.page : p)));
      onRun(await api.run(run.id));
      toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    setBusy({ label: t.busyUndo, about: t.about15 });
    try {
      const r = await api.undo(run.id);
      setPages(await api.pages(run.id));
      onRun(await api.run(run.id));
      if (r.pages[0]) setCur(r.pages[0]);
      toast(t.undone(r.undone));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function downloadPdf() {
    if (run.pdfReady) return void (location.href = `/api/runs/${run.id}/download.pdf`);
    setBusy({ label: t.busyPdf, about: t.about30to60 });
    try {
      const res = await fetch(`/api/runs/${run.id}/download.pdf`, { headers: langHeader() });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? t.pdfFailed);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${run.title}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
      setPages(await api.pages(run.id));
      onRun(await api.run(run.id));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  function emphasize() {
    const el = lastFocus.current;
    const name = el?.dataset.slot;
    if (!el || !name) return toast(t.emphSelectField, true);
    const { selectionStart: a, selectionEnd: b, value } = el;
    if (a === b) return toast(t.emphSelectWord, true);
    setDraft((d) => ({ ...d, [name]: `${value.slice(0, a)}[[${value.slice(a, b)}]]${value.slice(b)}` }));
  }

  const pageIssues = useMemo(() => run.issues.filter((i) => i.page === cur), [run.issues, cur]);
  const deckIssues = run.issues.filter((i) => i.page === null);
  const flags = useMemo(() => {
    const m: Record<number, 'error' | 'warning'> = {};
    for (const i of run.issues) if (i.page) m[i.page] = m[i.page] === 'error' || i.level === 'error' ? 'error' : 'warning';
    return m;
  }, [run.issues]);
  const shownIssues = dirty && draftIssues ? draftIssues : pageIssues;
  const draftBad = page?.slots.some((s) => fits[s.name] && !fits[s.name].ok);

  return (
    <div className="wrap-wide">
      <div className="ed-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <Link to="/" className="backlink">
            <IconBack />
            {t.edBack}
          </Link>
          <h1>{run.title}</h1>
          <div className="ed-meta">
            <span>{t.edMeta(run.slides, run.template, t.yen(Math.max(1, run.costJpy)))}</span>
            {(run.language === 'en' || uiLang === 'en') && <span>{t.deckLanguageMeta(run.language)}</span>}
            {run.errors ? (
              <span className="err">
                <IconAlert />
                {t.errorsCount(run.errors)}
              </span>
            ) : (
              <span className="ok">
                <IconShield />
                {t.noBlocking}
              </span>
            )}
            {run.warnings ? (
              <span className="warn">
                <IconNote />
                {t.warningsCount(run.warnings)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={!run.canUndo || !!busy} onClick={undo} title={t.undoTitle}>
            <IconUndo />
            {t.undo}
          </button>
          <button type="button" className="btn" disabled={!!busy} onClick={downloadPdf}>
            <IconDoc />
            {t.pdf}
          </button>
          <a className="btn btn-primary" href={`/api/runs/${run.id}/download.pptx`} aria-disabled={!!busy}>
            <IconDownload />
            {t.downloadPptx}
          </a>
        </div>
      </div>

      {run.issues.length > 0 && (
        <details className="card all-issues" open={run.errors > 0}>
          <summary>
            {t.allIssues(run.issues.length)}
            <span className="muted small hide-sp">{t.allIssuesHint}</span>
          </summary>
          <div className="list">
            {run.issues.map((i, k) => (
              <button key={k} type="button" className="jump" onClick={() => i.page && move(i.page)}>
                <span className={`badge ${i.level === 'error' ? 'badge-err' : 'badge-warn'}`}>{i.page ? t.pageN(i.page) : t.wholeDeck}</span>
                <span>
                  <b>{i.title}</b> <span className="muted small">{i.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </details>
      )}

      {!pages && <p className="muted">{t.loading}</p>}
      {pages && page && (
        <div className="ed">
          <nav className="thumbs" aria-label={t.pagesNav}>
            {pages.map((p) => (
              <button key={p.n} type="button" className={`thumb${p.n === cur ? ' on' : ''}`} onClick={() => move(p.n)} aria-current={p.n === cur}>
                <span className="thumb-n">{p.n}</span>
                <span className="thumb-img">
                  {p.image && <img src={p.image} alt={t.pageN(p.n)} loading="lazy" />}
                  {flags[p.n] && <span className={`thumb-flag ${flags[p.n] === 'error' ? 'flag-err' : 'flag-warn'}`} />}
                </span>
              </button>
            ))}
          </nav>

          <div className="ed-center">
            <div className="stage">
              <div className="stage-wrap">
                <div className="stage-img">{page.image && <img src={page.image} alt={t.pageAlt(cur)} />}</div>
              </div>
              {busy && <BusyCover busy={busy} elapsed={elapsed} />}
              <div className="stage-nav">
                <button type="button" className="btn" disabled={cur <= 1} onClick={() => move(cur - 1)}>
                  <IconBack />
                  {t.prev}
                </button>
                <span>{t.pageOf(cur, pages.length, page.typeLabel)}</span>
                <button type="button" className="btn btn-primary" disabled={cur >= pages.length} onClick={() => move(cur + 1)}>
                  {t.next}
                  <IconNext />
                </button>
              </div>
            </div>
            <div className="issues">
              {dirty && draftIssues && <p className="small muted">{t.checkingDraft}</p>}
              {shownIssues.map((i, k) => (
                <IssueCard key={k} i={i} />
              ))}
              {!shownIssues.length && (
                <div className="notice notice-ok">
                  <IconDocCheck />
                  {t.pageClean}
                </div>
              )}
              {deckIssues.map((i, k) => (
                <IssueCard key={`d${k}`} i={i} />
              ))}
            </div>
          </div>

          <aside className="card panel">
            <div className="tabs" role="tablist">
              {(
                [
                  ['text', t.tabText],
                  ['ai', t.tabAi],
                  ['type', t.tabType],
                  ['photo', t.tabPhoto],
                ] as Array<[Tab, string]>
              ).map(([k, l]) => (
                <button key={k} type="button" role="tab" className={tab === k ? 'on' : ''} aria-selected={tab === k} onClick={() => setTab(k)}>
                  {l}
                </button>
              ))}
            </div>

            {tab === 'text' && (
              <>
                <div className="panel-body">
                  <p className="hint">
                    {t.textHint1}
                    <code>[[ ]]</code>
                    {t.textHint2}
                  </p>
                  {page.slots.map((s) => {
                    const v = draft[s.name] ?? s.text;
                    const f = fits[s.name];
                    const bad = f && !f.ok;
                    return (
                      <div key={s.name} className="slot">
                        <div className="slot-head">
                          <label className="label" htmlFor={`s-${s.name}`}>
                            {s.label}
                          </label>
                          <span className={`count${bad ? ' bad' : ''}`}>
                            {t.charsOf(f ? f.chars : [...v.replace(/\[\[|\]\]|\n/g, '')].length)}
                            {s.maxChars ? t.maxChars(s.maxChars) : ''}
                            {s.maxLines && s.maxLines > 1 ? t.maxLines(s.maxLines) : ''}
                          </span>
                        </div>
                        <textarea
                          id={`s-${s.name}`}
                          data-slot={s.name}
                          className={`textarea${bad ? ' bad' : ''}`}
                          rows={Math.min(5, Math.max(1, s.maxLines ?? 1))}
                          value={v}
                          disabled={!!busy}
                          onFocus={(e) => (lastFocus.current = e.currentTarget)}
                          onChange={(e) => setDraft((d) => ({ ...d, [s.name]: e.target.value }))}
                        />
                        {bad && f.reason && <span className="reason">{f.reason.replace(/^この欄は/, '')}</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="panel-foot">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={emphasize} disabled={!!busy}>
                    {t.emphasize}
                  </button>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn" disabled={!dirty || !!busy} onClick={() => setDraft(Object.fromEntries(page.slots.map((s) => [s.name, s.text])))}>
                    {t.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!dirty || !!busy}
                    onClick={() => {
                      if (draftBad && !confirm(t.overflowConfirm)) return;
                      void act({ label: t.busySave, about: t.about15 }, () => api.saveText(run.id, cur, draft), t.savedPage(cur));
                    }}
                  >
                    {t.apply}
                  </button>
                </div>
              </>
            )}

            {tab === 'ai' && (
              <>
                <div className="panel-body">
                  <p className="hint">{t.aiHint}</p>
                  <div className="chips">
                    {t.aiChips.map((c) => (
                      <button key={c} type="button" className="chip" onClick={() => setInstruction((x) => (x ? t.chipJoin(x, c) : c))}>
                        {c}
                      </button>
                    ))}
                  </div>
                  <textarea className="textarea" rows={5} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t.aiPh} disabled={!!busy} />
                  {dirty && <div className="notice notice-warn small">{t.aiDraftNote}</div>}
                  <p className="hint">{t.aiCost}</p>
                </div>
                <div className="panel-foot">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!instruction.trim() || !!busy}
                    onClick={async () => {
                      if (await act({ label: t.busyAi, about: t.about30to60 }, () => api.aiRevise(run.id, cur, instruction), t.aiDone(cur))) setInstruction('');
                    }}
                  >
                    {t.aiRun}
                  </button>
                </div>
              </>
            )}

            {tab === 'type' && (
              <div className="panel-body">
                {page.canMirror && (
                  <div className="mirror">
                    <p className="hint">{t.mirrorHint(page.mirrored)}</p>
                    <button
                      type="button"
                      className="btn"
                      disabled={!!busy}
                      onClick={() => void act({ label: t.busyMirror, about: t.about20 }, () => api.toggleMirror(run.id, cur), t.mirrorDone(cur))}
                    >
                      {t.mirrorBtn}
                    </button>
                  </div>
                )}
                <p className="hint">{t.typeHint}</p>
                {!types && <p className="muted">{t.loading}</p>}
                <div className="types">
                  {types?.map((ty) => (
                    <button
                      key={ty.key}
                      type="button"
                      className={`type${ty.current ? ' on' : ''}`}
                      disabled={ty.current || !!busy}
                      onClick={() => {
                        if (!confirm(t.typeConfirm(ty.label))) return;
                        void act({ label: t.busyType(ty.label), about: t.about1min }, () => api.changeType(run.id, cur, ty.key), t.typeDone(cur)).then(() => setTypes(null));
                      }}
                    >
                      {tplTypes[ty.key] ? <img src={tplTypes[ty.key]!} alt="" loading="lazy" /> : <div style={{ aspectRatio: '16/9', background: '#eef1f6' }} />}
                      <span>
                        {ty.current ? t.typeCurrent : ty.sameRole ? t.typeRecommended : ''}
                        {ty.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === 'photo' && (
              <div className="panel-body">
                {page.photos.length === 0 && <p className="muted">{t.noPhotoSlots}</p>}
                {page.photos.length > 0 && <p className="hint">{t.photoHint}</p>}
                {page.photos.map((ph) => (
                  <div key={ph.name} className="slot-photo">
                    {ph.image ? <img src={ph.image} alt={ph.label} /> : <div className="ph" />}
                    <div className="stack-sm">
                      <b>{ph.label}</b>
                      <span className="hint">{ph.image ? '' : t.photoIsSample}</span>
                      <label className="btn btn-sm" style={{ justifySelf: 'start' }} aria-disabled={!!busy}>
                        {t.replacePhoto}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          hidden
                          disabled={!!busy}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) void act({ label: t.busyPhoto, about: t.about15 }, () => api.replacePhoto(run.id, cur, ph.name, f), t.photoReplaced);
                          }}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function IssueCard({ i }: { i: Issue }) {
  const t = useT();
  return (
    <div className={`issue issue-${i.level}`}>
      <div className="issue-title">
        <span className={`badge ${i.level === 'error' ? 'badge-err' : 'badge-warn'}`}>{i.levelText}</span>
        {i.title}
        {i.slotLabel && <span className="muted small">{t.slotParen(i.slotLabel)}</span>}
      </div>
      <div className="issue-detail">{i.detail}</div>
      <div className="issue-action">{i.action}</div>
    </div>
  );
}

function BusyCover({ busy, elapsed }: { busy: Busy; elapsed: number }) {
  const t = useT();
  return (
    <div className="busy" role="status">
      <div>
        <div className="spinner" />
        <b>{busy.label}</b>
        <div className="small muted">{t.busyAbout(busy.about, elapsed)}</div>
      </div>
    </div>
  );
}
