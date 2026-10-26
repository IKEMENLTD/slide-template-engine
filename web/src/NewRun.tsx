import { useEffect, useMemo, useRef, useState } from 'react';
import { api, minutes, yen, type AppState, type Estimate, type Template } from './api';
import { go, Link, useToast } from './ui';

type Photo = { file: File; url: string; note: string };

export function NewRun({ app }: { app: AppState | null }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
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

  const template = templates?.find((t) => t.id === tpl);
  const counts = useMemo(() => {
    const base = [5, 10, 15, 20];
    return template ? base.filter((n) => n >= template.minSlides && n <= template.maxSlides) : base;
  }, [template]);

  async function loadFile(f: File) {
    try {
      const r = await api.readManuscript(f);
      setText(r.text);
      toast(`「${f.name}」を読み込みました`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  function addPhotos(files: FileList | File[]) {
    const ok = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    if (ok.length < [...files].length) toast('写真は JPEG・PNG・WebP のものだけ追加しました', true);
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
    <>
      <div className="wrap">
        <div className="page-head">
          <div>
            <h1>新しく資料を作る</h1>
            <p className="muted">上から順に入れて、いちばん下の「作成を始める」を押してください。</p>
          </div>
        </div>
        {!ready && (
          <div className="notice notice-warn" style={{ marginBottom: 16 }}>
            文章を作る AI の鍵がまだ入っていないため、作成を始められません。<Link to="/settings">設定</Link>で入れてください。
          </div>
        )}
        <div className="card card-pad">
          <section className="section">
            <span className="num">1</span>
            <div className="stack">
              <div>
                <h2>原稿</h2>
                <p className="hint">伝えたいことを文章で書いてください。見出しや箇条書きがあると、ページに分けやすくなります。数字は原稿にあるものだけが使われます。</p>
              </div>
              <div className="field">
                <label className="label" htmlFor="title">
                  資料の名前（任意）
                </label>
                <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="空のままなら、AI が原稿から題を付けます" />
              </div>
              <div
                className={`drop${dragText ? ' on' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => (e.preventDefault(), setDragText(true))}
                onDragLeave={() => setDragText(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragText(false);
                  const f = e.dataTransfer.files[0];
                  if (f) void loadFile(f);
                }}
              >
                <b>Word・テキストのファイルから読み込む</b>
                <div className="hint">ここにファイルを置くか、押して選んでください（.docx・.txt・.md）</div>
                <input ref={fileRef} type="file" accept=".docx,.txt,.md" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
              </div>
              <div className="field">
                <label className="label" htmlFor="ms">
                  原稿の本文
                </label>
                <textarea id="ms" className="textarea" rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={'例：\n# 工場の現状\n受注は電話とファクスで受け、紙の指示書で回している。\n段取り替えに平均45分かかっている。\n\n# 3年後の目標\n稼働率を62%から80%へ。'} />
                <div className="spread hint">
                  <span>{chars ? `${chars.toLocaleString()}字` : 'まだ入っていません'}</span>
                  {tooShort && <span style={{ color: 'var(--error)' }}>短すぎます（80字以上にしてください）</span>}
                </div>
              </div>
            </div>
          </section>

          <section className="section">
            <span className="num">2</span>
            <div className="stack">
              <div>
                <h2>テンプレートと枚数</h2>
                <p className="hint">見た目（色・配置・字体）はテンプレートが決めます。</p>
              </div>
              <div className="tpls">
                {!templates && <p className="muted">読み込んでいます…</p>}
                {templates?.map((t) => (
                  <button key={t.id} type="button" className={`tpl${tpl === t.id ? ' on' : ''}`} onClick={() => setTpl(t.id)} aria-pressed={tpl === t.id}>
                    <div className="run-thumb">{t.cover ? <img src={t.cover} alt="" /> : <span className="muted small">見本を用意しています…</span>}</div>
                    <div className="tpl-name">
                      <span>{t.name}</span>
                      <span className="muted small nowrap">{t.types.length}種類のページ</span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="field">
                <span className="label">枚数</span>
                <div className="seg">
                  <button type="button" className={!slides && !custom ? 'on' : ''} onClick={() => (setSlides(null), setCustom(false))}>
                    おまかせ{est && chars ? `（${est.recommended}枚前後）` : ''}
                  </button>
                  {counts.map((n) => (
                    <button key={n} type="button" className={slides === n && !custom ? 'on' : ''} onClick={() => (setSlides(n), setCustom(false))}>
                      {n}枚
                    </button>
                  ))}
                  <button type="button" className={custom ? 'on' : ''} onClick={() => (setCustom(true), setSlides(slides ?? est?.recommended ?? 10))}>
                    枚数を指定
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
                      aria-label="枚数"
                    />
                  )}
                </div>
                <p className="hint">おまかせにすると、原稿の量に合わせて AI が決めます（{template ? `${template.minSlides}〜${template.maxSlides}枚` : ''}）。枚数を決めても、前後1〜2枚ずれることがあります。</p>
              </div>
            </div>
          </section>

          <section className="section">
            <span className="num">3</span>
            <div className="stack">
              <div>
                <h2>写真（任意）</h2>
                <p className="hint">使ってほしい写真があれば追加してください。写真は自動で白黒にし、枠に合わせて切り抜きます。</p>
              </div>
              <div
                className={`drop${dragPhoto ? ' on' : ''}`}
                onClick={() => photoRef.current?.click()}
                onDragOver={(e) => (e.preventDefault(), setDragPhoto(true))}
                onDragLeave={() => setDragPhoto(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragPhoto(false);
                  addPhotos(e.dataTransfer.files);
                }}
              >
                <b>写真を追加する</b>
                <div className="hint">ここに写真を置くか、押して選んでください（何枚でも）</div>
                <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => e.target.files && addPhotos(e.target.files)} />
              </div>
              {photos.length > 0 && (
                <div className="photos">
                  {photos.map((p, i) => (
                    <div key={p.url} className="card photo">
                      <img src={p.url} alt="" />
                      <input className="input" placeholder="何が写っているか（任意）" value={p.note} onChange={(e) => setPhotos((l) => l.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
                      <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => setPhotos((l) => l.filter((_, j) => j !== i))}>
                        外す
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={generate && !!app?.settings.imagesReady} disabled={!app?.settings.imagesReady} onChange={(e) => setGenerate(e.target.checked)} />
                <span>
                  足りない写真は AI で作る
                  <span className="hint" style={{ display: 'block' }}>
                    {app?.settings.imagesReady ? '人物や場面の写真を作ります。写真に文字は入れません。作らない場合は、テンプレートの見本の写真のままになります。' : '写真を作る AI の鍵が入っていないため、足りない写真はテンプレートの見本の写真のままになります。'}
                  </span>
                </span>
              </label>
            </div>
          </section>
        </div>
      </div>

      <div className="footbar">
        <div className="footbar-in">
          <div className="est">
            <span>
              <span className="muted small">枚数 </span>
              <b>{est && chars ? `${est.slides}枚${slides ? '' : '前後'}` : '―'}</b>
            </span>
            <span>
              <span className="muted small">かかる時間 </span>
              <b>{est && chars ? minutes(est.seconds) : '―'}</b>
            </span>
            <span>
              <span className="muted small">費用の目安 </span>
              <b>{est && app && chars ? yen(est.usd, app.usdJpy) : '―'}</b>
            </span>
          </div>
          <button type="button" className="btn btn-primary btn-lg" disabled={!canStart} onClick={start}>
            {sending ? '準備しています…' : '作成を始める'}
          </button>
        </div>
      </div>
    </>
  );
}
