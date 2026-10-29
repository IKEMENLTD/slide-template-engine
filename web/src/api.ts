/** サーバーの API。失敗したら、サーバーの理由（画面の言語の文）をそのまま投げる。呼ぶたびに画面の言語を X-UI-Lang で伝える */
import { getLang, tNow, type DeckLanguage, type PhotoPeople } from './i18n';

export type Issue = {
  level: 'error' | 'warning';
  levelText: string;
  page: number | null;
  slot: string | null;
  slotLabel: string | null;
  title: string;
  action: string;
  detail: string;
};

export type RunView = {
  id: string;
  title: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  step: string | null;
  stepLabel: string | null;
  detail: string | null;
  percent: number;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  queuePosition: number | null;
  error: string | null;
  template: string;
  createdAt: string;
  slides: number | null;
  errors: number;
  warnings: number;
  issues: Issue[];
  costUsd: number;
  costJpy: number;
  cover: string | null;
  pdfReady: boolean;
  canUndo: boolean;
  templateId: string | null;
  language: DeckLanguage;
  people: PhotoPeople;
};

export type SlotView = { name: string; label: string; kind: string; text: string; maxChars: number | null; maxLines: number | null; perLine: number | null };
export type PhotoView = { name: string; label: string; image: string | null; aspect: number | null };
export type PageView = { n: number; type: string; typeLabel: string; mirrored: boolean; canMirror: boolean; image: string | null; slots: SlotView[]; photos: PhotoView[] };
export type Fit = { ok: boolean; chars: number; maxChars: number | null; lines: number; maxLines: number | null; reason: string | null };
export type TypeChoice = { key: string; label: string; sameRole: boolean; current: boolean };

export type Template = {
  id: string;
  name: string;
  ready: boolean;
  cover: string | null;
  minSlides: number;
  maxSlides: number;
  types: Array<{ key: string; label: string; image: string | null }>;
};

export type AppState = {
  settings: { anthropicKey: string | null; openaiKey: string | null; monthlyBudgetUsd: number; usdJpy: number; aiReady: boolean; imagesReady: boolean; devMode: boolean };
  monthCostUsd: number;
  usdJpy: number;
};

export type Estimate = { recommended: number; slides: number; seconds: number; usd: number; jpy: number; chars: number; language: DeckLanguage };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-ui-lang': getLang() };
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(tNow().noServer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* JSON でない */
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? tNow().failedStatus(res.status));
  return data as T;
}

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  saveSettings: (b: { anthropicKey?: string; openaiKey?: string; monthlyBudgetUsd?: number; clear?: string[] }) => call<{ settings: AppState['settings'] }>('PUT', '/api/settings', b),
  templates: () => call<Template[]>('GET', '/api/templates'),
  readManuscript: (file: File) => {
    const f = new FormData();
    f.append('file', file);
    return call<{ text: string; title: string }>('POST', '/api/manuscript', f);
  },
  estimate: (b: { text: string; slides: number | null; generatePhotos: boolean }) => call<Estimate>('POST', '/api/estimate', b),
  runs: () => call<Omit<RunView, 'issues'>[]>('GET', '/api/runs'),
  createRun: (f: FormData) => call<{ id: string }>('POST', '/api/runs', f),
  run: (id: string) => call<RunView>('GET', `/api/runs/${id}`),
  resume: (id: string) => call('POST', `/api/runs/${id}/resume`),
  remove: (id: string) => call('DELETE', `/api/runs/${id}`),
  log: async (id: string) => (await fetch(`/api/runs/${id}/log`, { headers: langHeader() })).text(),
  pages: (id: string) => call<PageView[]>('GET', `/api/runs/${id}/pages`),
  types: (id: string, n: number) => call<TypeChoice[]>('GET', `/api/runs/${id}/pages/${n}/types`),
  check: (id: string, n: number, slots: Record<string, string>) => call<{ fits: Record<string, Fit>; issues: Issue[] }>('POST', `/api/runs/${id}/pages/${n}/check`, { slots }),
  saveText: (id: string, n: number, slots: Record<string, string>) => call<{ page: PageView }>('POST', `/api/runs/${id}/pages/${n}/text`, { slots }),
  aiRevise: (id: string, n: number, instruction: string) => call<{ page: PageView }>('POST', `/api/runs/${id}/pages/${n}/ai`, { instruction }),
  changeType: (id: string, n: number, type: string) => call<{ page: PageView }>('POST', `/api/runs/${id}/pages/${n}/type`, { type }),
  toggleMirror: (id: string, n: number) => call<{ page: PageView }>('POST', `/api/runs/${id}/pages/${n}/mirror`),
  replacePhoto: (id: string, n: number, slot: string, file: File) => {
    const f = new FormData();
    f.append('slot', slot);
    f.append('file', file);
    return call<{ page: PageView }>('POST', `/api/runs/${id}/pages/${n}/photo`, f);
  },
  versions: (id: string) => call<Array<{ at: string; label: string; page: number }>>('GET', `/api/runs/${id}/versions`),
  undo: (id: string) => call<{ undone: string; pages: number[] }>('POST', `/api/runs/${id}/undo`),
};

/** fetch に付ける、画面の言語の見出し（API を直接 fetch するところでも付ける） */
export const langHeader = () => ({ 'x-ui-lang': getLang() });

export const yen = (usd: number, rate: number) => tNow().yen(Math.max(1, Math.round(usd * rate)));
export const minutes = (sec: number) => (sec < 90 ? tNow().seconds(Math.max(10, Math.round(sec / 10) * 10)) : tNow().minutesText(Math.round(sec / 60)));
export const dateText = (iso: string) => {
  const d = new Date(iso);
  return tNow().date(d, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
};
