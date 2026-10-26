/**
 * 写真の欄の画像を差し替える（D段）。形（切り抜きの図形）・位置・大きさは見本のまま。
 * 画像はあらかじめ枠の縦横比に切り抜いておく（D-003。automizer の setRelationTargetCover は平行四辺形で失敗する）。
 * 見本の写真に付いていた切り抜きの指定（a:srcRect）は外す。残すと、枠の比に切り抜き済みの写真がさらに削られる。
 */
import { ModifyImageHelper, type XmlElement } from 'pptx-automizer';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export function replaceImage(fileName: string) {
  const set = ModifyImageHelper.setRelationTarget(fileName);
  return (element: XmlElement, relation?: XmlElement) => {
    if (!relation) throw new Error(`写真の欄に関係（relation）が無い: ${fileName}`);
    set(element, relation);
    const src = element.getElementsByTagNameNS(A, 'srcRect');
    for (let i = src.length - 1; i >= 0; i--) {
      const r = src.item(i)!;
      for (const k of ['l', 't', 'r', 'b']) r.removeAttribute(k);
    }
  };
}
