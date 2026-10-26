/**
 * 写真の欄の画像を差し替える（D段）。形（切り抜きの図形）・位置・大きさは見本のまま。
 * 画像はあらかじめ枠の縦横比に切り抜いておく（D-003。automizer の setRelationTargetCover は平行四辺形で失敗する）。
 */
import { ModifyImageHelper, type XmlElement } from 'pptx-automizer';

export function replaceImage(fileName: string) {
  const set = ModifyImageHelper.setRelationTarget(fileName);
  return (element: XmlElement, relation?: XmlElement) => {
    if (!relation) throw new Error(`写真の欄に関係（relation）が無い: ${fileName}`);
    set(element, relation);
  };
}
