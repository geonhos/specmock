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
      const code = node.firstChild?.nodeName === "CODE" ? (node.firstChild as HTMLElement) : (node as HTMLElement);
      const lang = (code.getAttribute("class") ?? "").match(/language-([\w-]+)/)?.[1] ?? "";
      return `\n\n\`\`\`${lang}\n${code.textContent ?? ""}\n\`\`\`\n\n`;
    },
  });
  return td;
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
  const { document } = parseHTML(html);
  unhide(document);
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  // keepClasses: Readability가 class를 지우면 위 언어 힌트가 사라지므로 남긴다.
  const article = new Readability(document as unknown as Document, { charThreshold: 200, keepClasses: true }).parse();
  const contentHtml = article?.content ?? document.querySelector("main, article, body")?.innerHTML ?? html;
  let markdown = turndown().turndown(contentHtml).trim();
  if (markdown.length === 0) markdown = (document.body?.textContent ?? "").trim();
  const finalTitle = article?.title?.trim() || title;
  // Readability는 <h1>을 제목으로 삼키고 본문에서 지운다. Markdown 입력과 같게 H1을 본문에 남겨 청크와 LLM이 문서 제목을 보게 한다.
  if (finalTitle && !/^# /.test(markdown)) markdown = `# ${finalTitle}\n\n${markdown}`;
  return { title: finalTitle, markdown: `<!-- source: ${url} -->\n\n${markdown}\n` };
}

export interface InteractiveReport { reasons: string[] }

/** 설계 5.1의 감지 규칙. bodyChars는 변환된 본문 길이. */
export function detectInteractive(html: string, bodyChars: number): InteractiveReport {
  const { document } = parseHTML(html);
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
