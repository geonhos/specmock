/** 스펙 경로·URL에서 시스템 이름을 제안한다. 파일은 확장자를 뺀 이름, URL은 호스트. */
export function suggestSystemName(origin: string): string {
  const v = origin.trim();
  if (!v) return "";
  let base: string;
  if (/^https?:\/\//i.test(v)) {
    try { base = new URL(v).hostname; } catch { return ""; }
  } else {
    const last = v.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const dot = last.lastIndexOf(".");
    base = dot > 0 ? last.slice(0, dot) : last;
  }
  return base.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
