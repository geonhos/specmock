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

export function formatCatalog(catalog: Catalog): string {
  const ordered = orderFeatures(catalog);
  const count = (p: Feature["provenance"]) => catalog.features.filter((f) => f.provenance === p).length;
  const lines: string[] = [];
  lines.push(`${catalog.system} — ${catalog.features.length}개 기능 (openapi ${count("openapi")} · 문서추출 ${count("doc-extracted")} · 추론 ${count("inferred")})`);
  lines.push("");

  const idW = Math.max(2, ...ordered.map((o) => o.feature.id.length));
  const pathW = Math.max(4, ...ordered.map((o) => o.feature.path.length));
  lines.push(`  ${pad("#", 3)} ${pad("id", idW)}  ${pad("method", 7)} ${pad("path", pathW)}  출처  신뢰  샘플`);

  let currentGroup: string | null = null;
  for (const { index, feature } of ordered) {
    if (feature.group !== currentGroup) {
      currentGroup = feature.group;
      const n = catalog.features.filter((f) => f.group === currentGroup).length;
      lines.push(`── ${currentGroup} (${n}) ` + "─".repeat(Math.max(0, 60 - currentGroup.length)));
    }
    const warn = feature.notes.length > 0 ? `  ⚠ ${feature.notes[0]}` : "";
    lines.push(
      `  ${pad(String(index), 3)} ${pad(feature.id, idW)}  ${pad(feature.method, 7)} ${pad(feature.path, pathW)}  ` +
        `${pad(PROVENANCE_LABEL[feature.provenance], 5)} ${feature.confidence.toFixed(1)}   ${sampleBadge(feature)}${warn}`,
    );
  }
  lines.push("");
  lines.push("범례  출처: spec=OpenAPI, doc=문서에서 추출, inf=추론 · 샘플: ●있음 ○스키마만 —없음");
  return lines.join("\n");
}
