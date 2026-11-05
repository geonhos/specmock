import { htmlToMarkdown } from "../ingest/html.js";
import { maskSecrets } from "../ingest/mask.js";
import { hashText } from "../util/hash.js";
import type { Harvested } from "../types.js";

export interface RawResult {
  pages: { url: string; title: string; html: string }[];
  interactions: { type: Harvested["interactions"][number]["type"]; label: string; html: string }[];
  notes: string[];
}

/** 수확 원본(HTML) → Markdown 변환 → 비밀값 마스킹 → (마스킹된 내용 기준) 중복 제거. */
export function normalizeHarvest(raw: RawResult, baseUrl: string): Harvested {
  const seen = new Set<string>();
  const dedupe = (md: string) => { const h = hashText(md.trim()); if (seen.has(h)) return false; seen.add(h); return true; };
  const pages = raw.pages
    .map((p) => ({ url: p.url, title: maskSecrets(p.title), content: maskSecrets(htmlToMarkdown(p.html, p.url).markdown) }))
    .filter((p) => dedupe(p.content));
  const interactions = raw.interactions
    .map((i) => ({ type: i.type, label: maskSecrets(i.label), content: maskSecrets(htmlToMarkdown(i.html, baseUrl).markdown) }))
    .filter((i) => i.content.trim().length > 0 && dedupe(i.content));
  return { pages, interactions, notes: raw.notes.map(maskSecrets) };
}
