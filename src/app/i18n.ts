/**
 * 画面の言語（日本語・英語）。画面は API を呼ぶたびに X-UI-Lang（ja / en）を付けて送る。
 * サーバーは要求ごとにその言語を覚えておき（AsyncLocalStorage）、画面に返す言葉と断りの文をその言語で作る。
 * 付いていなければ日本語（これまでどおり）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type UiLang = 'ja' | 'en';

const store = new AsyncLocalStorage<UiLang>();

export const langFromHeader = (v: string | null | undefined): UiLang => (v?.trim().toLowerCase().startsWith('en') ? 'en' : 'ja');

export function runWithLang<T>(lang: UiLang, fn: () => T): T {
  return store.run(lang, fn);
}

/** いま処理している要求の画面の言語（要求の外では日本語） */
export const currentLang = (): UiLang => store.getStore() ?? 'ja';
