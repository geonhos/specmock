import type { Feature, FeatureList } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../api";
import { FeatureDetail } from "../components/FeatureDetail";
import { FeatureTable } from "../components/FeatureTable";
import { Notice } from "../components/Notice";
import { SelectionBar } from "../components/SelectionBar";
import { pathFor } from "../route";
import { filterRows, sameIds } from "../selection";

export interface Change { n: number; system: string | null; files: string[] }
const SAVE_DEBOUNCE_MS = 400;
/** 우리가 저장한 직후 파일 감시가 알려 주는 변경은 외부 변경이 아니다. */
const OWN_ECHO_MS = 1000;
const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", e instanceof Error ? e.message : String(e)));
const touched = (c: Change, name: string) => c.files.length === 0 || c.files.some((f) => f === name || f.endsWith(`/${name}`));

export function Select({ system, change, header, go }: { system: string; change: Change | null; header: ReactNode; go: (path: string) => void }) {
  const [list, setList] = useState<FeatureList | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [saveErr, setSaveErr] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(false);
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; feature?: Feature; error?: ApiError } | null>(null);

  // 저장 상태는 렌더와 무관하게 이벤트 핸들러가 읽으므로 ref에 둔다.
  const sel = useRef(selected);            // 화면에 보이는 최신 선택
  const dirty = useRef(false);             // 디스크와 다른 로컬 변경이 있다(저장 대기·진행·실패·빈 선택)
  const needSave = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loop = useRef<Promise<boolean> | null>(null);
  const lastSave = useRef(-Infinity);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; if (timer.current) clearTimeout(timer.current); }, []);

  const apply = useCallback((next: Set<string>) => { sel.current = next; setSelected(next); }, []);

  /** 저장 루프: 진행 중이면 합류하고, 끝난 뒤 바뀐 값이 있으면 최신 값으로 한 번 더 보낸다. 빈 선택은 저장하지 않는다. */
  const flush = useCallback((): Promise<boolean> => {
    if (loop.current) return loop.current;
    const run = async (): Promise<boolean> => {
      let ok = true;
      try {
        while (needSave.current) {
          needSave.current = false;
          const ids = [...sel.current];
          if (ids.length === 0) continue;
          if (live.current) setSaving(true);
          try {
            await api.saveSelection(system, ids);
            lastSave.current = Date.now();
            if (live.current) setSaveErr(null);
            if (!needSave.current && !timer.current && sameIds(ids, sel.current)) dirty.current = false;
          } catch (e) {
            ok = false;
            if (live.current) setSaveErr(toErr(e));
            break;
          }
        }
      } finally { loop.current = null; if (live.current) setSaving(false); }
      return ok;
    };
    loop.current = run();
    return loop.current;
  }, [system]);

  const change_ = useCallback((next: Set<string>) => {
    apply(next);
    dirty.current = true;
    needSave.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (next.size === 0) return; // 빈 선택은 저장하지 않는다(화면이 이유를 안내한다)
    timer.current = setTimeout(() => { timer.current = null; void flush(); }, SAVE_DEBOUNCE_MS);
  }, [apply, flush]);

  const load = useCallback(async (what: "all" | "selection") => {
    try {
      const [l, s] = await Promise.all([what === "all" ? api.features(system) : Promise.resolve(null), api.selection(system)]);
      if (!live.current) return;
      setLoadErr(null);
      if (l) setList(l);
      const known = new Set((l ?? listRef.current)?.rows.map((r) => r.id));
      // 로컬에 저장 안 된 변경이 있으면 그 값을 지키고, 없으면 디스크 값을 따른다. 카탈로그에 없는 id는 어느 쪽이든 뺀다.
      const base = what === "all" && dirty.current ? sel.current : new Set(s?.resolved ?? []);
      apply(new Set([...base].filter((id) => known.has(id))));
    } catch (e) { if (live.current) setLoadErr(toErr(e)); }
  }, [system, apply]);
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => { void load("all"); }, [load]);

  // 외부 변경(workspace-changed). 마운트 이전 이벤트는 건너뛴다.
  const seen = useRef(change?.n ?? 0);
  useEffect(() => {
    if (!change || change.n === seen.current) return;
    seen.current = change.n;
    if (change.system !== null && change.system !== system) return;
    if (touched(change, "catalog.json")) { void load("all"); return; }
    if (!touched(change, "selection.json")) return;
    if (loop.current || Date.now() - lastSave.current < OWN_ECHO_MS) return; // 우리 저장의 메아리
    if (dirty.current) setBanner(true); else void load("selection");
  }, [change, system, load]);

  const reloadSelection = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null; needSave.current = false; dirty.current = false;
    setBanner(false); setSaveErr(null);
    void load("selection");
  };

  const openFeature = (id: string) => {
    setOpenId(id);
    setDetail({ id });
    api.feature(system, id).then((feature) => setDetail((d) => (d?.id === id ? { id, feature } : d))).catch((e: unknown) => setDetail((d) => (d?.id === id ? { id, error: toErr(e) } : d)));
  };

  const next = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (needSave.current || loop.current) { if (!(await flush())) return; }
    go(pathFor("generate", system));
  };

  const methods = useMemo(() => [...new Set((list?.rows ?? []).map((r) => r.method))], [list]);
  const visible = useMemo(() => filterRows(list?.rows ?? [], { q, method, group }), [list, q, method, group]);

  return (
    <>
      <main className="panel mid sel-mid">
        {header}
        {loadErr ? <Notice message={loadErr.message} hint={loadErr.hint} /> : null}
        {saveErr ? <Notice message={saveErr.message} hint={saveErr.hint ?? "선택은 화면에 그대로 있어요. 바꾸면 다시 저장해요."} /> : null}
        {banner ? (
          <div role="status" className="ft-banner">
            <span>다른 곳에서 선택이 바뀌었어요.</span>
            <button type="button" className="btn-ghost" onClick={reloadSelection}>다시 불러오기</button>
          </div>
        ) : null}
        {!list ? (loadErr ? null : <p className="muted">불러오는 중이에요</p>) : list.rows.length === 0 ? (
          <p className="muted">기능이 없어요. ② 분석을 먼저 해 주세요.</p>
        ) : (
          <>
            <div className="ft-filter">
              <input type="search" role="searchbox" aria-label="기능 검색" placeholder="경로·id 검색" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="ft-chips">
                {methods.map((m) => (
                  <button key={m} type="button" className={`ft-chip${method === m ? " on" : ""}`} style={{ color: `var(--${m.toLowerCase()})` }} aria-pressed={method === m} onClick={() => setMethod(method === m ? null : m)}>{m}</button>
                ))}
              </div>
              <select aria-label="그룹 필터" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">전체 그룹</option>
                {list.groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div className="ft-scroll">
              {visible.length === 0 ? <p className="muted">조건에 맞는 기능이 없어요.</p> : (
                <FeatureTable rows={visible} selected={selected} collapsed={collapsed} openId={openId} onSelect={change_} onOpen={openFeature}
                  onToggleCollapse={(g) => setCollapsed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })} />
              )}
            </div>
            <SelectionBar count={selected.size} saving={saving} onNext={() => void next()} />
          </>
        )}
      </main>
      <aside className="panel det" aria-label="상세">
        {!detail ? <p className="muted fd-empty">행을 누르면 자세히 볼 수 있어요.</p>
          : detail.error ? <Notice message={detail.error.message} hint={detail.error.hint} />
          : detail.feature ? <FeatureDetail feature={detail.feature} /> : <p className="muted fd-empty">불러오는 중이에요</p>}
      </aside>
    </>
  );
}
