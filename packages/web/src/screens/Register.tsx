import type { FeatureListRow, TargetInfo } from "@specmock/ui-server/api-types";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { ApiError, api } from "../api";
import { FeatureTable } from "../components/FeatureTable";
import { Notice } from "../components/Notice";
import { TargetForm } from "../components/TargetForm";
import { suggestSystemName } from "../name";
import { modelFromInfo, newRow, toPutBody, type FormModel } from "../recordModel";
import { pathFor } from "../route";
import { toggleGroup } from "../selection";

/** 화면에서 넣은 토큰의 환경 변수 이름. 값은 ui-server 메모리(EnvStore)에만 있다. */
export const TOKEN_ENV = "API_TOKEN";
const NOT_OPENAPI = "OpenAPI 스펙이 아니에요. 1차에서는 OpenAPI 스펙 URL만 등록할 수 있어요.";
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", String(e)));

export function Register({ go, onRegistered }: { go: (path: string) => void; onRegistered: () => void }) {
  const [origin, setOrigin] = useState("");
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [stage2, setStage2] = useState<{ system: string; model: FormModel; groups: { group: string; total: number }[] } | null>(null);
  const [rows, setRows] = useState<Map<string, FeatureListRow[]>>(new Map()); // 받은 묶음의 행만
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const readSpec = async () => {
    const system = name.trim();
    setBusy(true); setError(null);
    try {
      await api.ingest(system, [origin.trim()]);
      onRegistered();
      const a = await api.analyze(system);
      if (a.mode !== "catalog") { setError(new ApiError(400, "invalid", NOT_OPENAPI)); return; }
      if (token !== "") await api.setEnv(system, { [TOKEN_ENV]: token });
      const [info, summary] = await Promise.all([api.target(system), api.featureGroups(system)]);
      const model = modelFromInfo(info as TargetInfo);
      if (!info.exists) {
        model.baseUrl = info.suggestedBaseUrl ?? "";
        if (token !== "") model.headers = [newRow("Authorization", `Bearer \${${TOKEN_ENV}}`)];
      }
      // 큰 스펙(GitHub 46묶음 1,281개): 묶음 요약만 받고 접어 둔다. 행은 묶음을 열거나 고를 때 받는다(설계 §4 ①).
      setCollapsed(new Set(summary.groups.map((g) => g.group)));
      setRows(new Map());
      setStage2({ system, model, groups: summary.groups });
    } catch (e) { setError(asError(e)); } finally { setBusy(false); }
  };

  /** 묶음의 행은 처음 열거나 고를 때 한 번만 받는다. */
  const loadGroup = async (system: string, g: string): Promise<FeatureListRow[]> => {
    const have = rows.get(g);
    if (have) return have;
    const list = await api.features(system, g);
    setRows((m) => new Map(m).set(g, list.rows));
    return list.rows;
  };
  const toggleOpen = async (g: string) => {
    if (!stage2) return;
    if (collapsed.has(g)) { try { await loadGroup(stage2.system, g); } catch (e) { setError(asError(e)); return; } }
    setCollapsed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  };
  const selectGroup = async (g: string) => {
    if (!stage2) return;
    try { const rs = await loadGroup(stage2.system, g); setSelected((cur) => toggleGroup(rs, g, cur)); } catch (e) { setError(asError(e)); }
  };

  const finish = async () => {
    if (!stage2) return;
    setBusy(true); setError(null);
    try {
      // 열지 않은 묶음의 기능별 설정(target.json features)도 지우지 않도록 이미 저장된 id를 함께 넘긴다.
      const known = new Set([...[...rows.values()].flat().map((r) => r.id), ...Object.keys(stage2.model.features)]);
      const { body } = toPutBody(stage2.model, known);
      await api.putTarget(stage2.system, body);
      await api.saveSelection(stage2.system, [...selected]);
      await api.inferFlows(stage2.system);
      onRegistered();
      go(pathFor("flows", stage2.system));
    } catch (e) { setError(asError(e)); } finally { setBusy(false); }
  };

  if (!stage2) {
    const ready = origin.trim() !== "" && name.trim() !== "" && !busy;
    return (
      <form className="form reg-1" onSubmit={(e) => { e.preventDefault(); if (ready) void readSpec(); }}>
        <TextInput label="스펙 URL" value={origin} placeholder="https://…/openapi.yaml"
          onChange={(v) => { setOrigin(v); if (!edited) setName(suggestSystemName(v)); }} />
        <TextInput label="서비스 이름" value={name} onChange={(v) => { setName(v); setEdited(true); }} />
        <TextInput label="테스트 토큰" type="password" value={token} onChange={setToken} />
        <p className="muted">토큰은 이 화면을 띄운 서버의 메모리에만 두고 파일에 쓰지 않아요.</p>
        {error ? <Notice message={error.message} hint={error.hint} /> : null}
        <div className="action-row"><Button type="submit" variant="primary" label="스펙 읽기" isDisabled={!ready} /></div>
      </form>
    );
  }
  const totals = new Map(stage2.groups.map((g) => [g.group, g.total]));
  const total = stage2.groups.reduce((n, g) => n + g.total, 0);
  return (
    <div className="reg">
      <section className="reg-left" aria-label="대상 설정">
        <h2>대상 설정</h2>
        <TargetForm model={stage2.model} onChange={(model) => setStage2({ ...stage2, model })} />
      </section>
      <section className="reg-right" aria-label="기능 고르기">
        <h2>기능 고르기 <span className="muted">{selected.size}개 선택 · 전체 {total}개</span></h2>
        <FeatureTable rows={[...rows.values()].flat()} groups={stage2.groups.map((g) => g.group)} totals={totals} selected={selected} collapsed={collapsed}
          onSelect={setSelected} onGroupSelect={(g) => void selectGroup(g)} onToggleCollapse={(g) => void toggleOpen(g)} />
        {error ? <Notice message={error.message} hint={error.hint} /> : null}
        <div className="action-row">
          <Button variant="primary" label="등록하고 흐름 만들기" isDisabled={busy || selected.size === 0} onClick={() => void finish()} />
        </div>
      </section>
    </div>
  );
}
