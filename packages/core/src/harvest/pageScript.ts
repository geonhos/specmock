/**
 * 브라우저 문서 안에서 실행되는 순수 함수들. `page.evaluate(fn, arg)`로 넘기므로
 * 모듈 스코프의 다른 식별자를 참조하면 안 된다(각 함수는 자기 완결).
 */

export function expandAll(document: Document): number {
  let n = 0;
  for (const d of Array.from(document.querySelectorAll("details"))) { if (!d.hasAttribute("open")) { d.setAttribute("open", ""); n++; } }
  for (const el of Array.from(document.querySelectorAll("[aria-expanded='false']"))) { el.setAttribute("aria-expanded", "true"); n++; }
  return n;
}

export interface TabInfo { selector: string; label: string; panel: string }
export interface SelectInfo { selector: string; label: string; options: { value: string; label: string }[] }
export interface ListboxInfo { selector: string; label: string; optionCount: number }
export interface Interactives { tabs: TabInfo[]; selects: SelectInfo[]; listboxes: ListboxInfo[] }

export function collectInteractives(document: Document): Interactives {
  // id 없는 select/listbox는 속성 셀렉터로 가리킨다(>> nth= 에 의존하지 않는다).
  Array.from(document.querySelectorAll("select, [role='combobox'], [role='listbox']")).forEach((el, i) => el.setAttribute("data-specmock-i", String(i)));
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const labelFor = (el: Element): string => {
    const id = el.getAttribute("id");
    const byFor = id ? document.querySelector(`label[for='${id}']`) : null;
    if (byFor) return text(byFor).replace(text(el), "").trim();
    const wrap = el.closest("label");
    if (wrap) return text(wrap).replace(text(el), "").trim();
    return el.getAttribute("aria-label") ?? el.getAttribute("name") ?? id ?? "";
  };
  const cssId = (el: Element, fallback: string) => (el.getAttribute("id") ? `#${el.getAttribute("id")}` : fallback);
  const byIndex = (el: Element) => `[data-specmock-i='${el.getAttribute("data-specmock-i")}']`;

  const tabs: TabInfo[] = Array.from(document.querySelectorAll("[role='tab']")).map((t, i) => {
    const panel = t.getAttribute("aria-controls") ?? "";
    return { selector: panel ? `[role='tab'][aria-controls='${panel}']` : `[role='tab'] >> nth=${i}`, label: text(t), panel };
  });
  const selects: SelectInfo[] = Array.from(document.querySelectorAll("select")).map((s) => ({
    selector: cssId(s, byIndex(s)), label: labelFor(s),
    options: Array.from((s as HTMLSelectElement).options).map((o) => ({ value: o.value, label: text(o) })),
  }));
  const listboxes: ListboxInfo[] = Array.from(document.querySelectorAll("[role='combobox'], [role='listbox']")).map((l) => ({
    selector: cssId(l, byIndex(l)), label: labelFor(l), optionCount: l.querySelectorAll("[role='option']").length,
  }));
  return { tabs, selects, listboxes };
}

/** 탭 패널이 지금 보이는지. 이미 보이던 패널은 본문에 담겨 있으므로 저장하지 않는다. */
export function panelVisible(document: Document, panelId: string): boolean {
  const el = document.getElementById(panelId);
  if (!el) return false;
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  return !el.closest("[hidden]") && !/display\s*:\s*none/i.test(el.getAttribute("style") ?? "");
}

export function panelHtml(document: Document, panelId: string): string {
  return document.getElementById(panelId)?.outerHTML ?? "";
}

/** 지금 보이는 블록 요소(pre, p, li, 표, 헤딩 …)의 HTML 목록. 상호작용 전후를 비교해 새로 드러난 내용만 뽑는 데 쓴다. */
export function visibleBlocks(document: Document): string[] {
  const root = document.querySelector("main, article") ?? document.body;
  // checkVisibility가 없는 환경(linkedom 등) 폴백: 조상 중 인라인 display:none이 있으면 숨김.
  const hiddenByStyle = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) if (/display\s*:\s*none/i.test(e.getAttribute("style") ?? "")) return true;
    return false;
  };
  const out: string[] = [];
  for (const el of Array.from(root?.querySelectorAll("pre, p, li, table, h1, h2, h3, h4, h5, h6, blockquote") ?? [])) {
    const visible = typeof el.checkVisibility === "function"
      ? el.checkVisibility()
      : !el.closest("[hidden]") && !hiddenByStyle(el);
    // 바깥 블록이 이미 담았다면(예: li 안의 p) 중복이므로 가장 바깥 블록만 취한다.
    if (visible && !el.parentElement?.closest("pre, p, li, table, blockquote")) out.push(el.outerHTML);
  }
  return out;
}

/** 본문(main/article/body) HTML. 수확 전후 비교용. */
export function bodyHtml(document: Document): string {
  return (document.querySelector("main, article") ?? document.body)?.innerHTML ?? "";
}

export function referenceLinks(document: Document, currentUrl: string): string[] {
  const base = new URL(currentUrl);
  const out = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    let u: URL;
    try { u = new URL(a.getAttribute("href") ?? "", currentUrl); } catch { continue; }
    if (u.origin !== base.origin) continue;
    u.hash = "";
    if (u.href === base.href) continue;
    // 베어 /api/ 는 제외: 사용자 쿠키로 앱 API GET(예: /api/logout)을 방문할 수 있다.
    if (/\/(docs?|reference|api-reference|api-docs|endpoints?)(\/|$)/i.test(u.pathname)) out.add(u.href);
  }
  return Array.from(out).sort();
}
