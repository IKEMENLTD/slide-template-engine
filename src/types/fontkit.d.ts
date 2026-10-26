// fontkit 2.0 には型定義が同梱されていない。使っている分だけを書く
declare module 'fontkit' {
  export function openSync(path: string, postscriptName?: string): unknown;
}
