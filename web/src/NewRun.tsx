import { useEffect, useMemo, useRef, useState } from 'react';
import { api, minutes, yen, type AppState, type Estimate, type Template } from './api';
import { IconClock, IconCoins, IconImage, IconSlides, IconSpark, IconUpload } from './icons';
import { go, Link, useToast } from './ui';
import { useLang, useT, type DeckLanguage, type PhotoPeople } from './i18n';

type Photo = { file: File; url: string; note: string };

export function NewRun({ app }: { app: AppState | null }) {
  const toast = useToast();
  const t = useT();
  const uiLang = useLang();
  const [title, setTitle] = useState('');
  // 資料の言語と写真の人物。人が選ぶまでは、原稿の言語（無ければ画面の言語）から決める
  const [pickedLang, setPickedLang] = useState<DeckLanguage | null>(null);
  const [pickedPeople, setPickedPeople] = useState<PhotoPeople | null>(null);
  const [text, setText] = useState('');
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [tpl, setTpl] = useState<string>('');
  const [slides, setSlides] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [generate, setGenerate] = useState(true);
  const [est, setEst] = useState<Estimate | null>(null);
  const [sending, setSending] = useState(false);
  const [dragText, setDragText] = useState(false);
  const [dragPhoto, setDragPhoto] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  // テンプレート（見本の画像は初回だけ作るので、出来るまで読み直す）
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const load = () =>
      api.templates().then((l) => {
        if (!alive) return;
        setTemplates(l);
        setTpl((cur) => cur || l[0]?.id || '');
        if (l.some((x) => !x.ready)) t = setTimeout(load, 3000);
      });
    load().catch((e: Error) => toast(e.message, true));
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [toast]);

  // 目安（打つたびに少し待ってから）
  useEffect(() => {
    const t = setTimeout(() => {
      api.estimate({ text, slides, generatePhotos: generate && !!app?.settings.imagesReady }).then(setEst).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [text, slides, generate, app?.settings.imagesReady]);

  const template = templates?.find((x) => x.id === tpl);
  const deckLang: DeckLanguage = pickedLang ?? (est && est.chars > 0 ? est.language : uiLang);
  const people: PhotoPeople = pickedPeople ?? (deckLang === 'en' ? 'indian' : 'japanese');
  const counts = useMemo(() => {
    const base = [5, 10, 15, 20];
    return template ? base.filter((n) => n >= template.minSlides && n <= template.maxSlides) : base;
  }, [template]);

  async function loadFile(f: File) {
    try {
      const r = await api.readManuscript(f);
      setText(r.text);
      toast(t.loadedFile(f.name));
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  function addPhotos(files: FileList | File[]) {
    const ok = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    if (ok.length < [...files].length) toast(t.photoTypesOnly, true);
    setPhotos((p) => [...p, ...ok.map((file) => ({ file, url: URL.createObjectURL(file), note: '' }))]);
  }

  const chars = est?.chars ?? 0;
  const tooShort = chars > 0 && chars < 80;
  const ready = app?.settings.aiReady ?? false;
  const canStart = ready && chars >= 80 && !!tpl && !sending;

  async function start() {
    setSending(true);
    try {
      const f = new FormData();
      f.append('title', title);
      f.append('manuscript', text);
      f.append('template', tpl);
      if (slides) f.append('slides', String(slides));
      f.append('generatePhotos', generate ? '1' : '0');
      f.append('language', deckLang);
      f.append('people', people);
      for (const p of photos) {
        f.append('photos', p.file);
        f.append('photoNotes', p.note);
      }
      const { id } = await api.createRun(f);
      go(`/runs/${id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setSending(false);
    }
  }

  return (
    <div className="wrap">
      <div className="page-head">
        <div>
          <h1>{t.newTitle}</h1>
          <p className="muted">{t.newLead}</p>
        </div>
      </div>
      {!ready && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          {t.newNoKey1}
          <Link to="/settings">{t.newNoKeyLink}</Link>
          {t.newNoKey2}
        </div>
      )}
      <div className="compose">
        <div className="compose-main">
          <section className="card section">
            <span className="num">1</span>
            <div className="stack">
              <div>
                <h2>{t.msTitle}</h2>
                <p className="hint">{t.msHint}</p>
              </div>
              <div className="form-grid">
                <label className="label" htmlFor="title">
                  {t.deckName}
                </label>
                <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t.deckNamePh} />
                <span className="hide-sp" />
                <div
                  className={`drop${dragText ? ' on' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => fileRef.current?.click()}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fileRef.current?.click())}
                  onDragOver={(e) => (e.preventDefault(), setDragText(true))}
                  onDragLeave={() => setDragText(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragText(false);
                    const f = e.dataTransfer.files[0];
                    if (f) void loadFile(f);
                  }}
                >
                  <IconUpload />
                  <div>
                    <b>{t.fileDrop}</b>
                    <div className="hint">{t.fileDropHint}</div>
                  </div>
                  <input ref={fileRef} type="file" accept=".docx,.txt,.md" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
                </div>
                <label className="label" htmlFor="ms">
                  {t.msBody}
                </label>
                <div className="stack-sm">
                  <textarea id="ms" className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.msPh} />
                  <div className="spread hint">
                    <span>{chars ? t.charCount(chars) : t.msEmpty}</span>
                    {tooShort && <span style={{ color: 'var(--error)' }}>{t.msTooShort}</span>}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="card section">
            <span className="num">2</span>
            <div className="stack">
              <div>
                <h2>{t.langSecTitle}</h2>
                <p className="hint">{t.langSecHint}</p>
              </div>
              <div className="row row-wrap" style={{ gap: 16, alignItems: 'flex-end' }}>
                <label className="field" style={{ minWidth: 240 }}>
                  <span className="label">{t.deckLang}</span>
                  <select className="select" value={deckLang} onChange={(e) => setPickedLang(e.target.value as DeckLanguage)}>
                    <option value="ja" lang="ja">
                      {t.deckLangJa}
                    </option>
                    <option value="en">{t.deckLangEn}</option>
                  </select>
                </label>
                <label className="field" style={{ minWidth: 240 }}>
                  <span className="label">{t.people}</span>
                  <select className="select" value={people} onChange={(e) => setPickedPeople(e.target.value as PhotoPeople)}>
                    <option value="japanese">{t.peopleJapanese}</option>
                    <option value="indian">{t.peopleIndian}</option>
                    <option value="mixed">{t.peopleMixed}</option>
                  </select>
                </label>
              </div>
            </div>
          </section>

          <section className="card section">
            <span className="num">3</span>
            <div className="stack">
              <div>
                <h2>{t.tplTitle}</h2>
                <p className="hint">{t.tplHint}</p>
              </div>
              <div className="tpl-row">
                <div className="field">
                  <span className="label">{t.tplChoose}</span>
                  <div className="tpls">
                    {!templates && <p className="muted">{t.loading}</p>}
                    {templates?.map((x) => (
                      <button key={x.id} type="button" className={`tpl${tpl === x.id ? ' on' : ''}`} onClick={() => setTpl(x.id)} aria-pressed={tpl === x.id}>
                        <span className="tpl-radio" aria-hidden="true" />
                        <div className="run-thumb">{x.cover ? <img src={x.cover} alt="" /> : <span className="muted small">{t.tplPreparing}</span>}</div>
                        <div className="tpl-name">
                          {x.name}
                          <div className="muted">{t.tplTypes(x.types.length)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span className="label">{t.slidesLabel}</span>
                  <div className="seg">
                    <button type="button" className={!slides && !custom ? 'on' : ''} onClick={() => (setSlides(null), setCustom(false))}>
                      {t.slidesAuto}
                      {est && chars ? t.slidesAround(est.recommended) : ''}
                    </button>
                    {counts.map((n) => (
                      <button key={n} type="button" className={slides === n && !custom ? 'on' : ''} onClick={() => (setSlides(n), setCustom(false))}>
                        {t.slidesN(n)}
                      </button>
                    ))}
                    <button type="button" className={custom ? 'on' : ''} onClick={() => (setCustom(true), setSlides(slides ?? est?.recommended ?? 10))}>
                      {t.slidesCustom}
                    </button>
                    {custom && (
                      <input
                        className="input"
                        style={{ width: 90 }}
                        type="number"
                        min={template?.minSlides ?? 4}
                        max={template?.maxSlides ?? 20}
                        value={slides ?? ''}
                        onChange={(e) => setSlides(e.target.value ? Math.max(template?.minSlides ?? 4, Math.min(template?.maxSlides ?? 20, Number(e.target.value))) : null)}
                        aria-label={t.slidesLabel}
                      />
                    )}
                  </div>
                  <p className="hint">{t.slidesHint(template ? t.slidesRange(template.minSlides, template.maxSlides) : '')}</p>
                </div>
              </div>
            </div>
          </section>

          <section className="card section">
            <span className="num">4</span>
            <div className="stack">
              <div>
                <h2>
                  {t.photosTitle}
                  <small>{t.optional}</small>
                </h2>
                <p className="hint">{t.photosHint}</p>
              </div>
              <div
                className={`drop${dragPhoto ? ' on' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => photoRef.current?.click()}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), photoRef.current?.click())}
                onDragOver={(e) => (e.preventDefault(), setDragPhoto(true))}
                onDragLeave={() => setDragPhoto(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragPhoto(false);
                  addPhotos(e.dataTransfer.files);
                }}
              >
                <IconImage />
                <div>
                  <b>{t.photosAdd}</b>
                  <div className="hint">{t.photosAddHint}</div>
                </div>
                <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => e.target.files && addPhotos(e.target.files)} />
              </div>
              {photos.length > 0 && (
                <div className="photos">
                  {photos.map((p, i) => (
                    <div key={p.url} className="card photo">
                      <img src={p.url} alt="" />
                      <input className="input" placeholder={t.photoNotePh} value={p.note} onChange={(e) => setPhotos((l) => l.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
                      <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => setPhotos((l) => l.filter((_, j) => j !== i))}>
                        {t.remove}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={generate && !!app?.settings.imagesReady} disabled={!app?.settings.imagesReady} onChange={(e) => setGenerate(e.target.checked)} />
                <span>
                  {t.genPhotos}
                  <span className="hint" style={{ display: 'block' }}>
                    {app?.settings.imagesReady ? t.genPhotosOn : t.genPhotosOff}
                  </span>
                </span>
              </label>
            </div>
          </section>

          <div className="card estbar">
            <div className="est">
              <span>
                <IconSlides />
                <span>
                  <small>{t.estSlides}</small>
                  <b>{est && chars ? t.estSlidesValue(est.slides, !slides) : '―'}</b>
                </span>
              </span>
              <span>
                <IconClock />
                <span>
                  <small>{t.estTime}</small>
                  <b>{est && chars ? minutes(est.seconds) : '―'}</b>
                </span>
              </span>
              <span>
                <IconCoins />
                <span>
                  <small>{t.estCost}</small>
                  <b>{est && app && chars ? yen(est.usd, app.usdJpy) : '―'}</b>
                </span>
              </span>
            </div>
            <button type="button" className="btn btn-primary btn-lg" disabled={!canStart} onClick={start}>
              <IconSpark />
              {sending ? t.preparing : t.start}
            </button>
          </div>
        </div>
        <div className="art-panel" aria-hidden="true">
          <img src="/art/slides.jpg" alt="" />
        </div>
      </div>
    </div>
  );
}
