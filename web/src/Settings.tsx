import { useState } from 'react';
import { api, yen, type AppState } from './api';
import { IconCoins } from './icons';
import { useToast } from './ui';

export function Settings({ app, onSaved }: { app: AppState | null; onSaved: () => void }) {
  const toast = useToast();
  const [anthropic, setAnthropic] = useState('');
  const [openai, setOpenai] = useState('');
  const [budget, setBudget] = useState<string>('');
  const [saving, setSaving] = useState(false);
  if (!app) return <div className="wrap muted">読み込んでいます…</div>;
  const s = app.settings;

  async function save(b: Parameters<typeof api.saveSettings>[0], done: string) {
    setSaving(true);
    try {
      await api.saveSettings(b);
      setAnthropic('');
      setOpenai('');
      setBudget('');
      onSaved();
      toast(done);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  const usedPct = s.monthlyBudgetUsd ? Math.min(100, Math.round((app.monthCostUsd / s.monthlyBudgetUsd) * 100)) : null;

  return (
    <div className="wrap settings stack">
      <div>
        <h1>設定</h1>
        <p className="muted">AI を使うための鍵と、費用の上限を決めます。鍵はこのアプリのサーバーにだけ保存し、画面には末尾4文字しか出しません。</p>
      </div>
      {s.devMode && <div className="notice notice-info">いまは開発用の設定で動いています（鍵を入れると、その鍵を使うように切り替わります）。</div>}

      <section className="card set-sec">
        <span className="num">1</span>
        <div className="stack">
          <h2>文章を作る AI（Claude）</h2>
          <div className="key-state">
            <span className={`sdot ${s.anthropicKey ? 'ok' : 'err'}`} />
            {s.anthropicKey ? '設定済み' : '未設定'}
            {s.anthropicKey && <code>{s.anthropicKey}</code>}
          </div>
          <p className="hint">
            ページ割り・文章・見た目の確認に使います（必須）。鍵は Anthropic の管理画面（
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            ）の「API Keys」で作れます。「sk-ant-」で始まる文字です。
          </p>
          <div className="key-row">
            <input className="input" type="password" autoComplete="off" aria-label="Claude の鍵" placeholder={s.anthropicKey ? '新しい鍵に替えるときだけ貼り付け' : 'sk-ant-… を貼り付け'} value={anthropic} onChange={(e) => setAnthropic(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={!anthropic.trim() || saving} onClick={() => save({ anthropicKey: anthropic }, 'Claude の鍵を保存しました')}>
              保存
            </button>
          </div>
          {s.anthropicKey && (
            <button type="button" className="linkbtn btn-danger" style={{ justifySelf: 'start' }} onClick={() => confirm('Claude の鍵を消します。資料を作れなくなります。よろしいですか？') && save({ clear: ['anthropicKey'] }, '鍵を消しました')}>
              この鍵を消す
            </button>
          )}
        </div>
      </section>

      <section className="card set-sec">
        <span className="num">2</span>
        <div className="stack">
          <h2>写真を作る AI（OpenAI）</h2>
          <div className="key-state">
            <span className={`sdot ${s.openaiKey ? 'ok' : ''}`} />
            {s.openaiKey ? '設定済み' : '任意・未設定'}
            {s.openaiKey && <code>{s.openaiKey}</code>}
          </div>
          <p className="hint">
            支給の写真が足りないときに、写真を作るのに使います（任意）。入れない場合は、テンプレートの見本の写真のままになります。鍵は OpenAI の管理画面（
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
              platform.openai.com
            </a>
            ）で作れます。
          </p>
          <div className="key-row">
            <input className="input" type="password" autoComplete="off" aria-label="OpenAI の鍵" placeholder={s.openaiKey ? '新しい鍵に替えるときだけ貼り付け' : 'sk-… を貼り付け'} value={openai} onChange={(e) => setOpenai(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={!openai.trim() || saving} onClick={() => save({ openaiKey: openai }, 'OpenAI の鍵を保存しました')}>
              保存
            </button>
          </div>
          {s.openaiKey && (
            <button type="button" className="linkbtn btn-danger" style={{ justifySelf: 'start' }} onClick={() => confirm('OpenAI の鍵を消します。よろしいですか？') && save({ clear: ['openaiKey'] }, '鍵を消しました')}>
              この鍵を消す
            </button>
          )}
        </div>
      </section>

      <section className="card set-sec">
        <span className="num">3</span>
        <div className="stack">
          <h2>費用</h2>
          <div className="cost">
            <div className="stack-sm">
              <span className="row muted">
                <IconCoins />
                今月かかった費用（目安）
              </span>
              <div className="cost-big">
                約<b>{yen(app.monthCostUsd, app.usdJpy).replace(/^約/, '').replace(/円$/, '')}</b>円 <span className="muted small">（${app.monthCostUsd.toFixed(2)}）</span>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="budget">
                月の上限（ドル）
              </label>
              <div className="key-row" style={{ maxWidth: 420 }}>
                <input id="budget" className="input" type="number" min={0} step={1} placeholder={String(s.monthlyBudgetUsd || 0)} value={budget} onChange={(e) => setBudget(e.target.value)} />
                <button type="button" className="btn btn-primary" disabled={budget === '' || saving} onClick={() => save({ monthlyBudgetUsd: Number(budget) }, '上限を保存しました')}>
                  保存
                </button>
              </div>
              <p className="hint">この金額に達すると、その月は新しい資料の作成と AI の直しを止めます。0 にすると上限なしです。いまの上限：{s.monthlyBudgetUsd ? `$${s.monthlyBudgetUsd}（${yen(s.monthlyBudgetUsd, app.usdJpy)}）` : 'なし'}</p>
            </div>
          </div>
          {usedPct !== null && (
            <div className="stack-sm">
              <div className="spread small muted">
                <span>上限に対する使った割合</span>
                <span>約{usedPct}%</span>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.max(1, usedPct)}%` }} />
              </div>
            </div>
          )}
          <p className="hint">目安：資料1つ（10枚）で約100〜120円、20枚で約130円です（写真を AI で作る場合）。円はおおよそ（1ドル{app.usdJpy}円）で計算しています。</p>
        </div>
      </section>
    </div>
  );
}
