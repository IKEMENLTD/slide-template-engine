/**
 * 欄の文言を差し替える（D段）。見本の書式（最初の段落の pPr と最初の文字の rPr）を引き継ぎ、文字だけを入れ替える。
 * 強調語は [[語]] で印を付ける。印の部分だけ、同じ書式に「太字＋テーマ色の下線」を足した別の run にする（D-009）。
 * 書式の値はここで決めない。強調の色と太字は引数（設定 emphasis）から受ける。
 */
import type { XmlElement } from 'pptx-automizer';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

export type EmphasisStyle = { underline: string; bold: boolean };

/** [[語]] を run の並びに分ける。印の対応が崩れていたら例外にする（黙って印を残さない） */
export function splitEmphasis(line: string): Array<{ text: string; emphasis: boolean }> {
  const parts = line.split(/(\[\[[^[\]]*\]\])/);
  const out: Array<{ text: string; emphasis: boolean }> = [];
  for (const p of parts) {
    if (p === '') continue;
    const m = p.match(/^\[\[([^[\]]*)\]\]$/);
    if (m) out.push({ text: m[1], emphasis: true });
    else {
      if (p.includes('[[') || p.includes(']]')) throw new Error(`強調の印の対応が崩れている: ${line}`);
      out.push({ text: p, emphasis: false });
    }
  }
  return out;
}

/** a:rPr の子要素は順番が決まっている（CT_TextCharacterProperties）。uFill は latin/ea/cs/sym/hlink の前 */
function insertUFill(rpr: XmlElement, uFill: XmlElement) {
  const after = ['latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst'];
  for (let n = rpr.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && after.includes((n as XmlElement).localName!)) {
      rpr.insertBefore(uFill, n);
      return;
    }
  }
  rpr.appendChild(uFill);
}

export function replaceText(text: string, emphasis: EmphasisStyle) {
  return (el: XmlElement) => {
    const doc = el.ownerDocument!;
    const txBody = el.getElementsByTagNameNS(P, 'txBody').item(0);
    if (!txBody) throw new Error('文字枠が無い図形に文言を入れようとした');
    const paras = Array.from({ length: txBody.getElementsByTagNameNS(A, 'p').length }, (_, i) => txBody.getElementsByTagNameNS(A, 'p').item(i)!);
    const p0 = paras[0];
    const pPr = p0.getElementsByTagNameNS(A, 'pPr').item(0);
    const baseRpr = p0.getElementsByTagNameNS(A, 'rPr').item(0) ?? p0.getElementsByTagNameNS(A, 'endParaRPr').item(0);
    if (!baseRpr) throw new Error('見本の文字の書式が無い');
    // 見本の段落はすべて消す（ダミー文言を残さない）
    for (const p of paras) txBody.removeChild(p);

    for (const line of text.split('\n')) {
      const p = doc.createElementNS(A, 'a:p');
      if (pPr) p.appendChild(pPr.cloneNode(true));
      for (const part of splitEmphasis(line)) {
        const r = doc.createElementNS(A, 'a:r');
        const rpr = baseRpr.cloneNode(true) as XmlElement;
        if (rpr.localName === 'endParaRPr') {
          // endParaRPr しか無い見本でも、run の書式として使えるように名前を変える
          const fixed = doc.createElementNS(A, 'a:rPr');
          for (const a of Array.from({ length: rpr.attributes.length }, (_, i) => rpr.attributes.item(i)!)) fixed.setAttribute(a.name, a.value);
          while (rpr.firstChild) fixed.appendChild(rpr.firstChild);
          r.appendChild(fixed);
        } else r.appendChild(rpr);
        const runPr = r.firstChild as XmlElement;
        runPr.removeAttribute('dirty');
        if (part.emphasis) {
          if (emphasis.bold) runPr.setAttribute('b', '1');
          runPr.setAttribute('u', 'heavy');
          const uFill = doc.createElementNS(A, 'a:uFill');
          const sf = doc.createElementNS(A, 'a:solidFill');
          const sc = doc.createElementNS(A, 'a:schemeClr');
          sc.setAttribute('val', emphasis.underline);
          sf.appendChild(sc);
          uFill.appendChild(sf);
          insertUFill(runPr, uFill);
        }
        const t = doc.createElementNS(A, 'a:t');
        t.textContent = part.text;
        r.appendChild(t);
        p.appendChild(r);
      }
      const end = doc.createElementNS(A, 'a:endParaRPr');
      for (const a of Array.from({ length: baseRpr.attributes.length }, (_, i) => baseRpr.attributes.item(i)!)) end.setAttribute(a.name, a.value);
      p.appendChild(end);
      txBody.appendChild(p);
    }
  };
}
