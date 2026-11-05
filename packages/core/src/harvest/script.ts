import { bodyHtml, collectInteractives, expandAll, panelHtml, panelVisible, referenceLinks, visibleBlocks } from "./pageScript.js";

export interface HarvestParams { url: string; outFile: string; maxPages: number; maxDepth: number; spaceName: string; perPageTimeoutMs: number }

/**
 * `ego-browser nodejs`에 넘길 스크립트 본문. 환경변수와 cwd를 상속하지 않으므로 모든 값을 리터럴로 박는다.
 * 결과는 outFile에 JSON으로 쓴다: { pages: [{url,title,html}], interactions: [{type,label,html}], notes: [] }
 * HTML → Markdown 변환은 코어(Node 쪽)에서 htmlToMarkdown으로 한다.
 */
export function buildHarvestScript(p: HarvestParams): string {
  const fns = [expandAll, collectInteractives, panelHtml, panelVisible, bodyHtml, referenceLinks, visibleBlocks].map((f) => f.toString()).join("\n");
  return `
const PARAMS = ${JSON.stringify(p)};
// 페이지 함수는 첫 인자로 document를 받는다. 문자열 식으로 평가해 document를 넘기고,
// tsx/esbuild(keepNames)가 함수 소스에 섞는 __name(...) 호출은 항등 함수로 흡수한다.
const inPage = (fn, ...args) => page.evaluate("(() => { const __name = (f) => f; return (" + fn.toString() + ")(document" + args.map((a) => "," + JSON.stringify(a)).join("") + "); })()");
${fns}
const { writeFile } = await import("node:fs/promises");
const result = { pages: [], interactions: [], notes: [] };
const task = await taskSpace(PARAMS.spaceName);
const page = task.page("p1");
const seen = new Set(); // 방문했거나 큐에 들어간 URL
seen.add(PARAMS.url);
let visited = 0;
const queue = [{ url: PARAMS.url, depth: 0 }];

async function diffAfter(action, label, type) {
  const before = new Set(await inPage(visibleBlocks));
  try { await action(); } catch (e) { result.notes.push(label + ": " + (e && e.message ? e.message : String(e))); return; }
  await new Promise((r) => setTimeout(r, 300));
  const added = (await inPage(visibleBlocks)).filter((b) => !before.has(b));
  if (added.length) result.interactions.push({ type, label, html: added.join("\\n") });
}

while (queue.length && visited < PARAMS.maxPages) {
  const { url, depth } = queue.shift();
  visited++;
  try { await page.goto(url, { timeout: PARAMS.perPageTimeoutMs }); } catch (e) { result.notes.push("goto 실패 " + url + ": " + e.message); continue; }
  const cur = String(await page.url()); // 리다이렉트 후 URL
  seen.add(cur);
  await inPage(expandAll);
  const title = await page.title();
  const inter = await inPage(collectInteractives);
  for (const t of inter.tabs) {
    const tabLabel = (title || url) + " / 탭 패널: " + t.label;
    if (!t.panel) { await diffAfter(() => page.click(t.selector, { label: "open tab " + t.label }), tabLabel, "tab"); continue; }
    if (await inPage(panelVisible, t.panel)) continue; // 처음부터 보이던 패널은 본문에 이미 있다
    try { await page.click(t.selector, { label: "open tab " + t.label }); } catch (e) { result.notes.push((title || url) + " / 탭 " + t.label + ": " + (e && e.message ? e.message : String(e))); continue; }
    await new Promise((r) => setTimeout(r, 300));
    const html = await inPage(panelHtml, t.panel);
    if (html) result.interactions.push({ type: "tab", label: (title || url) + " / 탭 패널: " + t.label, html });
  }
  for (const s of inter.selects) {
    for (const o of s.options) {
      await diffAfter(() => page.selectOption(s.selector, o.value), (title || url) + " / " + (s.label || s.selector) + " = " + o.label, "select");
    }
  }
  for (const l of inter.listboxes) result.notes.push("커스텀 드롭다운 " + (l.label || l.selector) + " (옵션 " + l.optionCount + "개)는 자동 수확하지 않음. 수동 탐색 필요");
  if (depth > 0) result.pages.push({ url: cur, title, html: await inPage(bodyHtml) }); // 시작 페이지 본문은 input.content에 이미 있다
  if (depth < PARAMS.maxDepth) for (const link of await inPage(referenceLinks, cur)) if (!seen.has(link)) { seen.add(link); queue.push({ url: link, depth: depth + 1 }); }
}
if (queue.length) result.notes.push("페이지 상한 " + PARAMS.maxPages + " 도달. 미방문 " + queue.length + "개");
await writeFile(PARAMS.outFile, JSON.stringify(result), "utf8");
await task.finish({ keep: [] });
console.log("harvest done: pages=" + result.pages.length + " interactions=" + result.interactions.length);
`;
}
