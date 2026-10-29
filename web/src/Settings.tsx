import { useState } from 'react';
import { api, yen, type AppState } from './api';
import { IconCoins } from './icons';
import { useToast } from './ui';
import { useLang, useT } from './i18n';

export function Settings({ app, onSaved }: { app: AppState | null; onSaved: () => void }) {
  const toast = useToast();
  const t = useT();
  const lang = useLang();
  const [anthropic, setAnthropic] = useState('');
  const [openai, setOpenai] = useState('');
  const [budget, setBudget] = useState<string>('');
  const [saving, setSaving] = useState(false);
  if (!app) return <div className="wrap muted">{t.loading}</div>;
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
        <h1>{t.setTitle}</h1>
        <p className="muted">{t.setLead}</p>
      </div>
      {s.devMode && <div className="notice notice-info">{t.devMode}</div>}

      <section className="card set-sec">
        <span className="num">1</span>
        <div className="stack">
          <h2>{t.claudeTitle}</h2>
          <div className="key-state">
            <span className={`sdot ${s.anthropicKey ? 'ok' : 'err'}`} />
            {s.anthropicKey ? t.keySet : t.keyUnset}
            {s.anthropicKey && <code>{s.anthropicKey}</code>}
          </div>
          <p className="hint">
            {t.claudeHint1}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            {t.claudeHint2}
          </p>
          <div className="key-row">
            <input className="input" type="password" autoComplete="off" aria-label={t.claudeKeyAria} placeholder={s.anthropicKey ? t.keyReplacePh : t.claudeKeyPh} value={anthropic} onChange={(e) => setAnthropic(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={!anthropic.trim() || saving} onClick={() => save({ anthropicKey: anthropic }, t.claudeSaved)}>
              {t.save}
            </button>
          </div>
          {s.anthropicKey && (
            <button type="button" className="linkbtn btn-danger" style={{ justifySelf: 'start' }} onClick={() => confirm(t.claudeDeleteConfirm) && save({ clear: ['anthropicKey'] }, t.keyDeleted)}>
              {t.deleteKey}
            </button>
          )}
        </div>
      </section>

      <section className="card set-sec">
        <span className="num">2</span>
        <div className="stack">
          <h2>{t.openaiTitle}</h2>
          <div className="key-state">
            <span className={`sdot ${s.openaiKey ? 'ok' : ''}`} />
            {s.openaiKey ? t.keySet : t.keyOptionalUnset}
            {s.openaiKey && <code>{s.openaiKey}</code>}
          </div>
          <p className="hint">
            {t.openaiHint1}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
              platform.openai.com
            </a>
            {t.openaiHint2}
          </p>
          <div className="key-row">
            <input className="input" type="password" autoComplete="off" aria-label={t.openaiKeyAria} placeholder={s.openaiKey ? t.keyReplacePh : t.openaiKeyPh} value={openai} onChange={(e) => setOpenai(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={!openai.trim() || saving} onClick={() => save({ openaiKey: openai }, t.openaiSaved)}>
              {t.save}
            </button>
          </div>
          {s.openaiKey && (
            <button type="button" className="linkbtn btn-danger" style={{ justifySelf: 'start' }} onClick={() => confirm(t.openaiDeleteConfirm) && save({ clear: ['openaiKey'] }, t.keyDeleted)}>
              {t.deleteKey}
            </button>
          )}
        </div>
      </section>

      <section className="card set-sec">
        <span className="num">3</span>
        <div className="stack">
          <h2>{t.costTitle}</h2>
          <div className="cost">
            <div className="stack-sm">
              <span className="row muted">
                <IconCoins />
                {t.costThisMonth}
              </span>
              <div className="cost-big">
                {lang === 'ja' ? (
                  <>
                    約<b>{yen(app.monthCostUsd, app.usdJpy).replace(/^約/, '').replace(/円$/, '')}</b>円
                  </>
                ) : (
                  <b>{yen(app.monthCostUsd, app.usdJpy)}</b>
                )}{' '}
                <span className="muted small">{t.paren(`$${app.monthCostUsd.toFixed(2)}`)}</span>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="budget">
                {t.budgetLabel}
              </label>
              <div className="key-row" style={{ maxWidth: 420 }}>
                <input id="budget" className="input" type="number" min={0} step={1} placeholder={String(s.monthlyBudgetUsd || 0)} value={budget} onChange={(e) => setBudget(e.target.value)} />
                <button type="button" className="btn btn-primary" disabled={budget === '' || saving} onClick={() => save({ monthlyBudgetUsd: Number(budget) }, t.budgetSaved)}>
                  {t.save}
                </button>
              </div>
              <p className="hint">{t.budgetHint(s.monthlyBudgetUsd ? `$${s.monthlyBudgetUsd}${t.paren(yen(s.monthlyBudgetUsd, app.usdJpy))}` : t.budgetNone)}</p>
            </div>
          </div>
          {usedPct !== null && (
            <div className="stack-sm">
              <div className="spread small muted">
                <span>{t.budgetUsed}</span>
                <span>{t.approxPct(usedPct)}</span>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.max(1, usedPct)}%` }} />
              </div>
            </div>
          )}
          <p className="hint">{t.costGuide(app.usdJpy)}</p>
        </div>
      </section>
    </div>
  );
}
