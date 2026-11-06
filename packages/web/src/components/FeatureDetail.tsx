import type { Feature } from "@specmock/ui-server/api-types";
import { PathText } from "./FeatureTable";

type Schema = Record<string, unknown> | null | undefined;
const typeOf = (s: Schema): string => {
  const t = s?.["type"];
  return typeof t === "string" ? t : Array.isArray(t) ? t.join("|") : s ? "object" : "any";
};
const json = (v: unknown) => JSON.stringify(v, null, 2);

/** 요청 필드 표 한 줄씩: 경로·쿼리·헤더 + 본문 최상위 속성. */
export function requestFields(f: Feature): { name: string; where: string; type: string; required: boolean }[] {
  const out: { name: string; where: string; type: string; required: boolean }[] = [];
  for (const [where, group] of [["path", f.request.params], ["query", f.request.query], ["header", f.request.headers]] as const) {
    for (const [name, p] of Object.entries(group)) out.push({ name, where, type: typeOf(p.schema), required: p.required });
  }
  const body = f.request.body;
  const props = body?.["properties"];
  if (props && typeof props === "object") {
    const req = Array.isArray(body["required"]) ? (body["required"] as string[]) : [];
    for (const [name, s] of Object.entries(props as Record<string, Schema>)) out.push({ name, where: "body", type: typeOf(s), required: req.includes(name) });
  } else if (body) out.push({ name: "(본문)", where: "body", type: typeOf(body), required: true });
  return out;
}

export function FeatureDetail({ feature }: { feature: Feature }) {
  const fields = requestFields(feature);
  const codes = Object.keys(feature.responses);
  return (
    <div className="fd">
      <div className="fd-head">
        <span className="ft-method" style={{ color: `var(--${feature.method.toLowerCase()})` }}>{feature.method}</span>
        <h2 className="fd-path"><PathText path={feature.path} dim={false} /></h2>
        <p className="fd-sum">{feature.summary || feature.title}</p>
      </div>
      <dl className="fd-facts">
        <div><dt>그룹</dt><dd>{feature.group}</dd></div>
        <div><dt>응답</dt><dd>{codes.length ? codes.join(" · ") : "-"}</dd></div>
        <div><dt>필드</dt><dd>{fields.length}개</dd></div>
      </dl>
      <section aria-labelledby="fd-req">
        <h3 id="fd-req">요청 필드</h3>
        {fields.length ? (
          <table className="fd-table">
            <thead><tr><th>이름</th><th>위치</th><th>타입</th><th>필수</th></tr></thead>
            <tbody>{fields.map((x) => (
              <tr key={`${x.where}.${x.name}`}><td className="mono">{x.name}</td><td>{x.where}</td><td className="mono">{x.type}</td><td>{x.required ? "필수" : "-"}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="fd-none">요청 필드가 없어요.</p>}
      </section>
      <section aria-labelledby="fd-res">
        <h3 id="fd-res">응답 예시</h3>
        {codes.length ? codes.map((c) => {
          const r = feature.responses[c]!;
          const ex = r.examples[0];
          return (
            <div key={c}>
              <p className="fd-code">{c}{ex ? ` · ${ex.source === "spec-example" ? "스펙 예시" : "문서 예시"}` : r.schema ? " · 스키마" : ""}</p>
              {ex || r.schema ? <pre>{json(ex ? ex.body : r.schema)}</pre> : <p className="fd-none">예시가 없어요.</p>}
            </div>
          );
        }) : <p className="fd-none">응답 정보가 없어요.</p>}
      </section>
      <section aria-labelledby="fd-src">
        <h3 id="fd-src">출처</h3>
        <p className="fd-src">{feature.provenance} · 신뢰도 {Math.round(feature.confidence * 100)}%</p>
        {feature.evidence.map((e, i) => <blockquote key={i} className="fd-quote">{e.quote}</blockquote>)}
        {feature.notes.map((n, i) => <p key={i} className="fd-note">⚠ {n}</p>)}
      </section>
    </div>
  );
}
