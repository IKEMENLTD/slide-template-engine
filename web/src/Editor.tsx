import { IconAlert, IconBack, IconDoc, IconDocCheck, IconDownload, IconNext, IconNote, IconShield, IconUndo } from './icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Fit, type Issue, type PageView, type RunView, type TypeChoice } from './api';
import { Link, useElapsed, useToast } from './ui';

type Tab = 'text' | 'ai' | 'type' | 'photo';
type Busy = { label: string; about: string };

const AI_CHIPS = ['もっと短く', 'わかりやすい言葉に', '見出しを言い切りの形に', '数字を目立たせて', '堅すぎない言い方に', '強調を外して'];

export function Editor({ run, onRun }: { run: RunView; onRun: (r: RunView) => void }) {
  const toast = useToast();
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
        const t = ts.find((x) => x.name === run.template) ?? ts[0];
        setTplTypes(Object.fromEntries((t?.types ?? []).map((x) => [x.key, x.image])));
      })
      .catch(() => {});
  }, [run.id, run.template, toast]);

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
    const t = setTimeout(() => {
      api
        .check(run.id, cur, draft)
        .then((r) => (setFits(r.fits), setDraftIssues(r.issues)))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [draft, dirty, page, cur, run.id]);

  useEffect(() => {
    if (tab === 'type' && !types && page) api.types(run.id, cur).then(setTypes).catch((e: Error) => toast(e.message, true));
  }, [tab, types, page, run.id, cur, toast]);

  const move = useCallback(
    (n: number) => {
      if (!pages || n < 1 || n > pages.length || n === cur) return;
      if (dirty && !confirm('書きかけの文字は反映していません。捨ててほかのページへ移りますか？')) return;
      setCur(n);
    },
    [pages, cur, dirty]
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
    setBusy({ label: '元に戻しています', about: '約15秒' });
    try {
      const r = await api.undo(run.id);
      setPages(await api.pages(run.id));
      onRun(await api.run(run.id));
      if (r.pages[0]) setCur(r.pages[0]);
      toast(`戻しました：${r.undone}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function downloadPdf() {
    if (run.pdfReady) return void (location.href = `/api/runs/${run.id}/download.pdf`);
    setBusy({ label: '直した内容で PDF を作っています', about: '約30秒〜1分' });
    try {
      const res = await fetch(`/api/runs/${run.id}/download.pdf`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'PDF を作れませんでした');
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
    if (!el || !name) return toast('強調したい語を、文字の欄で選んでから押してください', true);
    const { selectionStart: a, selectionEnd: b, value } = el;
    if (a === b) return toast('強調したい語を選んでから押してください', true);
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
            資料
          </Link>
          <h1>{run.title}</h1>
          <div className="ed-meta">
            <span>
              {run.slides}枚・{run.template}・費用 約{Math.max(1, run.costJpy).toLocaleString()}円
            </span>
            {run.errors ? (
              <span className="err">
                <IconAlert />
                直すところ {run.errors}
              </span>
            ) : (
              <span className="ok">
                <IconShield />
                止める指摘なし
              </span>
            )}
            {run.warnings ? (
              <span className="warn">
                <IconNote />
                確認 {run.warnings}
              </span>
            ) : null}
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={!run.canUndo || !!busy} onClick={undo} title="いちばん最後の直しを取り消します">
            <IconUndo />
            元に戻す
          </button>
          <button type="button" className="btn" disabled={!!busy} onClick={downloadPdf}>
            <IconDoc />
            PDF
          </button>
          <a className="btn btn-primary" href={`/api/runs/${run.id}/download.pptx`} aria-disabled={!!busy}>
            <IconDownload />
            PowerPoint をダウンロード
          </a>
        </div>
      </div>

      {run.issues.length > 0 && (
        <details className="card all-issues" open={run.errors > 0}>
          <summary>
            確認が要るところ（{run.issues.length}件）
            <span className="muted small hide-sp">ページを押すと、そのページに移ります</span>
          </summary>
          <div className="list">
            {run.issues.map((i, k) => (
              <button key={k} type="button" className="jump" onClick={() => i.page && move(i.page)}>
                <span className={`badge ${i.level === 'error' ? 'badge-err' : 'badge-warn'}`}>{i.page ? `${i.page}ページ` : '全体'}</span>
                <span>
                  <b>{i.title}</b> <span className="muted small">{i.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </details>
      )}

      {!pages && <p className="muted">読み込んでいます…</p>}
      {pages && page && (
        <div className="ed">
          <nav className="thumbs" aria-label="ページ">
            {pages.map((p) => (
              <button key={p.n} type="button" className={`thumb${p.n === cur ? ' on' : ''}`} onClick={() => move(p.n)} aria-current={p.n === cur}>
                <span className="thumb-n">{p.n}</span>
                <span className="thumb-img">
                  {p.image && <img src={p.image} alt={`${p.n}ページ`} loading="lazy" />}
                  {flags[p.n] && <span className={`thumb-flag ${flags[p.n] === 'error' ? 'flag-err' : 'flag-warn'}`} />}
                </span>
              </button>
            ))}
          </nav>

          <div className="ed-center">
            <div className="stage">
              <div className="stage-wrap">
                <div className="stage-img">{page.image && <img src={page.image} alt={`${cur}ページ目`} />}</div>
              </div>
              {busy && <BusyCover busy={busy} elapsed={elapsed} />}
              <div className="stage-nav">
                <button type="button" className="btn" disabled={cur <= 1} onClick={() => move(cur - 1)}>
                  <IconBack />
                  前へ
                </button>
                <span>
                  {cur} / {pages.length}ページ・{page.typeLabel}
                </span>
                <button type="button" className="btn btn-primary" disabled={cur >= pages.length} onClick={() => move(cur + 1)}>
                  次へ
                  <IconNext />
                </button>
              </div>
            </div>
            <div className="issues">
              {dirty && draftIssues && <p className="small muted">書きかけの文字で検査しています（まだ反映していません）</p>}
              {shownIssues.map((i, k) => (
                <IssueCard key={k} i={i} />
              ))}
              {!shownIssues.length && (
                <div className="notice notice-ok">
                  <IconDocCheck />
                  このページに気になるところはありません。
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
                  ['text', '文字'],
                  ['ai', 'AIに頼む'],
                  ['type', '形を替える'],
                  ['photo', '写真'],
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
                    書き換えると、枠に収まるかをその場で測ります。<code>[[ ]]</code> で囲んだ語は強調（下線）になります（1ページ2か所まで）。
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
                            {f ? `${f.chars}字` : `${[...v.replace(/\[\[|\]\]|\n/g, '')].length}字`}
                            {s.maxChars ? ` / ${s.maxChars}字まで` : ''}
                            {s.maxLines && s.maxLines > 1 ? `・${s.maxLines}行まで` : ''}
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
                    選んだ語を強調
                  </button>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn" disabled={!dirty || !!busy} onClick={() => setDraft(Object.fromEntries(page.slots.map((s) => [s.name, s.text])))}>
                    取り消し
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!dirty || !!busy}
                    onClick={() => {
                      if (draftBad && !confirm('枠に収まっていない欄があります。このまま反映しますか？（文字がはみ出して見えます）')) return;
                      void act({ label: '文字を反映して、ページを描き直しています', about: '約15秒' }, () => api.saveText(run.id, cur, draft), `${cur}ページ目に反映しました`);
                    }}
                  >
                    反映する
                  </button>
                </div>
              </>
            )}

            {tab === 'ai' && (
              <>
                <div className="panel-body">
                  <p className="hint">このページをどう直してほしいかを書いてください。AI が原稿の内容の範囲で書き直し、枠に収まるまで整えます（原稿に無い数字や名前は足しません）。</p>
                  <div className="chips">
                    {AI_CHIPS.map((c) => (
                      <button key={c} type="button" className="chip" onClick={() => setInstruction((x) => (x ? `${x}。${c}` : c))}>
                        {c}
                      </button>
                    ))}
                  </div>
                  <textarea className="textarea" rows={5} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="例：見出しをもっと短く、言い切りの形に。2つ目の項目は「残業」の話にして。" disabled={!!busy} />
                  {dirty && <div className="notice notice-warn small">「文字」で書きかけの内容は使われません（反映した文言をもとに直します）。</div>}
                  <p className="hint">1回 約30秒〜1分・費用は約2〜5円です。気に入らなければ「元に戻す」で戻せます。</p>
                </div>
                <div className="panel-foot">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!instruction.trim() || !!busy}
                    onClick={async () => {
                      if (await act({ label: 'AI がこのページを直しています', about: '約30秒〜1分' }, () => api.aiRevise(run.id, cur, instruction), `${cur}ページ目を AI が直しました`)) setInstruction('');
                    }}
                  >
                    AIに直してもらう
                  </button>
                </div>
              </>
            )}

            {tab === 'type' && (
              <div className="panel-body">
                <p className="hint">ページの形（レイアウト）を替えます。文字は AI が新しい形に合わせて書き直します（約1分）。上のほうが、いまのページに合う形です。項目の少ない形を選ぶと、入りきらない内容は外れます（「元に戻す」で戻せます）。</p>
                {!types && <p className="muted">読み込んでいます…</p>}
                <div className="types">
                  {types?.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className={`type${t.current ? ' on' : ''}`}
                      disabled={t.current || !!busy}
                      onClick={() => {
                        if (!confirm(`このページを「${t.label}」の形に替えます。文字は AI が書き直します（約1分）。\n項目の数が減る場合、入りきらない内容は外れます。`)) return;
                        void act({ label: `「${t.label}」の形に替えています`, about: '約1分' }, () => api.changeType(run.id, cur, t.key), `${cur}ページ目の形を替えました`).then(() => setTypes(null));
                      }}
                    >
                      {tplTypes[t.key] ? <img src={tplTypes[t.key]!} alt="" loading="lazy" /> : <div style={{ aspectRatio: '16/9', background: '#eef1f6' }} />}
                      <span>
                        {t.current ? 'いまの形：' : t.sameRole ? 'おすすめ：' : ''}
                        {t.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === 'photo' && (
              <div className="panel-body">
                {page.photos.length === 0 && <p className="muted">このページには写真の欄がありません。写真を入れたいときは「形を替える」で写真のある形を選んでください。</p>}
                {page.photos.length > 0 && <p className="hint">写真を選ぶと、白黒にして枠に合わせて切り抜き、差し替えます（約15秒）。人の顔が残るように切り抜きます。</p>}
                {page.photos.map((ph) => (
                  <div key={ph.name} className="slot-photo">
                    {ph.image ? <img src={ph.image} alt={ph.label} /> : <div className="ph" />}
                    <div className="stack-sm">
                      <b>{ph.label}</b>
                      <span className="hint">{ph.image ? '' : 'いまはテンプレートの見本の写真です'}</span>
                      <label className="btn btn-sm" style={{ justifySelf: 'start' }} aria-disabled={!!busy}>
                        写真を替える
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          hidden
                          disabled={!!busy}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) void act({ label: '写真を加工して差し替えています', about: '約15秒' }, () => api.replacePhoto(run.id, cur, ph.name, f), '写真を差し替えました');
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
  return (
    <div className={`issue issue-${i.level}`}>
      <div className="issue-title">
        <span className={`badge ${i.level === 'error' ? 'badge-err' : 'badge-warn'}`}>{i.levelText}</span>
        {i.title}
        {i.slotLabel && <span className="muted small">（{i.slotLabel}）</span>}
      </div>
      <div className="issue-detail">{i.detail}</div>
      <div className="issue-action">{i.action}</div>
    </div>
  );
}

function BusyCover({ busy, elapsed }: { busy: Busy; elapsed: number }) {
  return (
    <div className="busy" role="status">
      <div>
        <div className="spinner" />
        <b>{busy.label}</b>
        <div className="small muted">
          {busy.about}かかります（{elapsed}秒経過）
        </div>
      </div>
    </div>
  );
}
