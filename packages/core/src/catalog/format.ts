import type { Catalog, Feature } from "../types.js";
import { orderFeatures } from "./order.js";

const PROVENANCE_LABEL: Record<Feature["provenance"], string> = { openapi: "spec", "doc-extracted": "doc", inferred: "inf" };

function sampleBadge(f: Feature): string {
  if (f.hasExample) return "●";
  const hasSchema = Object.values(f.responses).some((r) => r.schema !== null);
  return hasSchema ? "○" : "—";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export interface FormatCatalogOptions {
  /** 지정하면 이 그룹의 행만 보여준다. 번호는 전체 카탈로그 기준으로 유지된다 (select의 번호와 일치). */
  group?: string;
}

export function formatCatalog(catalog: Catalog, opts: FormatCatalogOptions = {}): string {
  // 번호는 항상 전체 카탈로그에서 매긴다. 그룹 필터는 표시 행만 거른다.
  const ordered = orderFeatures(catalog).filter((o) => opts.group === undefined || o.feature.group === opts.group);
  const count = (p: Feature["provenance"]) => catalog.features.filter((f) => f.provenance === p).length;
  const lines: string[] = [];
  if (opts.group !== undefined) {
    lines.push(`${catalog.system} — 그룹 ${opts.group}: ${ordered.length}개 기능 (전체 ${catalog.features.length}개)`);
  } else {
    lines.push(`${catalog.system} — ${catalog.features.length}개 기능 (openapi ${count("openapi")} · 문서추출 ${count("doc-extracted")} · 추론 ${count("inferred")})`);
  }
  lines.push("");

  const idW = Math.max(2, ...ordered.map((o) => o.feature.id.length));
  const pathW = Math.max(4, ...ordered.map((o) => o.feature.path.length));
  const header = `  ${pad("#", 3)} ${pad("id", idW)}  ${pad("method", 7)} ${pad("path", pathW)}  출처  신뢰  샘플`;
  const width = header.length;
  if (ordered.length === 0) lines.push("  (기능 없음)");
  else lines.push(header);

  let currentGroup: string | null = null;
  for (const { index, feature } of ordered) {
    if (feature.group !== currentGroup) {
      currentGroup = feature.group;
      const n = catalog.features.filter((f) => f.group === currentGroup).length;
      const prefix = `── ${currentGroup} (${n}) `;
      lines.push(prefix + "─".repeat(Math.max(0, width - prefix.length)));
    }
    const more = feature.notes.length > 1 ? ` 외 ${feature.notes.length - 1}건` : "";
    const warn = feature.notes.length > 0 ? `  ⚠ ${feature.notes[0]}${more}` : "";
    lines.push(
      `  ${pad(String(index), 3)} ${pad(feature.id, idW)}  ${pad(feature.method, 7)} ${pad(feature.path, pathW)}  ` +
        `${pad(PROVENANCE_LABEL[feature.provenance], 5)} ${feature.confidence.toFixed(1)}   ${sampleBadge(feature)}${warn}`,
    );
  }
  lines.push("");
  lines.push("범례  출처: spec=OpenAPI, doc=문서에서 추출, inf=추론 · 샘플: ●있음 ○스키마만 —없음");
  return lines.join("\n");
}
