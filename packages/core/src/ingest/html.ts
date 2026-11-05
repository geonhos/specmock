import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MIN_BODY_CHARS = 2000;

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use(gfm);
  // <pre><code class="language-json"> 의 언어 힌트를 펜스에 남긴다. <code> 없는 맨 <pre>도 펜스로 만든다(문서 사이트의 curl 예시 등).
  td.addRule("fencedWithLang", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_c, node) => {
      const pre = node as HTMLElement;
      const code = Array.from(pre.children).find((c) => c.nodeName === "CODE") ?? pre;
      const classes = `${code.getAttribute("class") ?? ""} ${pre.getAttribute("class") ?? ""}`;
      const lang = classes.match(/language-([\w-]+)/)?.[1] ?? "";
      const text = (code.textContent ?? "").replace(/\n$/, "");
      // 코드 안의 백틱 열보다 긴 펜스를 고른다(turndown 기본 동작과 같다).
      let size = 3;
      for (const m of text.matchAll(/^`{3,}/gm)) size = Math.max(size, m[0].length + 1);
      const fence = "`".repeat(size);
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });
  return td;
}

/**
 * linkedom은 빈 문자열이면 documentElement가 null이고(body 접근 시 throw), <html> 없는 조각이면 첫 요소(<p> 등)를
 * documentElement로 삼고 빈 body를 만들어 Readability가 본문을 못 본다. 둘 다 body로 감싸 다시 파싱한다.
 */
function parseDocument(html: string): Document {
  let { document } = parseHTML(html);
  if (document.documentElement?.nodeName !== "HTML") ({ document } = parseHTML(`<html><body>${html}</body></html>`));
  return document as unknown as Document;
}

/** hidden 요소는 Readability가 버리므로, 변환 전에 hidden/aria-hidden을 벗겨 탭 패널·접힌 응답 예시도 본문에 남긴다. */
function unhide(document: Document): void {
  for (const el of document.querySelectorAll("[hidden], [aria-hidden='true'], details")) {
    el.removeAttribute("hidden");
    el.removeAttribute("aria-hidden");
    if (el.tagName === "DETAILS") el.setAttribute("open", "");
  }
}

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const document = parseDocument(html);
  unhide(document);
  const title = document.querySelector("title")?.textContent ?? "";
  // keepClasses: Readability가 class를 지우면 위 언어 힌트가 사라지므로 남긴다.
  const article = new Readability(document, { charThreshold: 200, keepClasses: true }).parse();
  const contentHtml = article?.content ?? document.querySelector("main, article, body")?.innerHTML ?? html;
  let markdown = turndown().turndown(contentHtml).trim();
  if (markdown.length === 0) markdown = (document.body?.textContent ?? "").trim();
  const finalTitle = (article?.title?.trim() || title).replace(/\s+/g, " ").trim();
  // Readability는 <h1>을 제목으로 삼키고 본문에서 지운다. Markdown 입력과 같게 H1을 본문에 남겨 청크와 LLM이 문서 제목을 보게 한다.
  if (finalTitle && !/^# /.test(markdown)) markdown = `# ${finalTitle}\n\n${markdown}`;
  return { title: finalTitle, markdown: `<!-- source: ${url} -->\n\n${markdown}\n` };
}

export interface InteractiveReport { reasons: string[] }

/** 설계 5.1의 감지 규칙. bodyChars는 변환된 본문 길이. */
export function detectInteractive(html: string, bodyChars: number): InteractiveReport {
  const document = parseDocument(html);
  const reasons: string[] = [];
  if (bodyChars < MIN_BODY_CHARS) reasons.push("본문 2,000자 미만");
  const count = (sel: string) => document.querySelectorAll(sel).length;
  const selects = count("select");
  if (selects) reasons.push(`select 요소 ${selects}개`);
  const tabs = count("[role='tab']");
  if (tabs) reasons.push(`tab 요소 ${tabs}개`);
  const details = count("details");
  if (details) reasons.push(`details 요소 ${details}개`);
  const combos = count("[role='combobox'], [role='listbox']");
  if (combos) reasons.push(`combobox/listbox 요소 ${combos}개`);
  if (/show more|더 ?보기|load more/i.test(document.body?.textContent ?? "")) reasons.push('"Show more"/"더 보기" 텍스트');
  return { reasons };
}
