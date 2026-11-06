import type { Feature, FeatureList } from "@specmock/ui-server/api-types";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../api";
import { FeatureDetail } from "../components/FeatureDetail";
import { FeatureTable } from "../components/FeatureTable";
import { Notice } from "../components/Notice";
import { SelectionBar } from "../components/SelectionBar";
import { pathFor } from "../route";
import { originLabel } from "../format";
import { filterRows, sameIds, toggleAll } from "../selection";

export interface Change { n: number; system: string | null; files: string[] }
const SAVE_DEBOUNCE_MS = 400;
const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "failed", e instanceof Error ? e.message : String(e)));
const touched = (c: Change, name: string) => c.files.length === 0 || c.files.some((f) => f === name || f.endsWith(`/${name}`));

export function Select({ system, change, header, go }: { system: string; change: Change | null; header: ReactNode; go: (path: string) => void }) {
  const [list, setList] = useState<FeatureList | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [saveErr, setSaveErr] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBannerState] = useState(false);
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; feature?: Feature; error?: ApiError } | null>(null);

  // 저장 상태는 렌더와 무관하게 이벤트 핸들러가 읽으므로 ref에 둔다.
  const sel = useRef(selected);            // 화면에 보이는 최신 선택
  const dirty = useRef(false);             // 디스크와 다른 로컬 변경이 있다(저장 대기·진행·실패)
  const needSave = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loop = useRef<Promise<boolean> | null>(null);
  const lastSaved = useRef<string[] | null>(null); // 마지막으로 알고 있는 디스크 선택(우리가 저장했거나 읽은 값)
  const recheck = useRef(false);           // 저장 루프 중에 selection 이벤트가 왔다
  const checkSeq = useRef(0);
  const checkRef = useRef<() => void>(() => undefined);
  const bannerOn = useRef(false);          // 배너가 떠 있으면 자동 저장을 멈춘다
  const live = useRef(true);
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const setBanner = useCallback((v: boolean) => { bannerOn.current = v; if (live.current) setBannerState(v); }, []);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (dirty.current && needSave.current && !bannerOn.current) void flushRef.current(); // 디바운스 중 화면을 옮겨도 마지막 변경을 저장한다
    };
  }, []);

  const apply = useCallback((next: Set<string>) => { sel.current = next; setSelected(next); }, []);

  /** 저장 루프: 진행 중이면 합류하고, 끝난 뒤 바뀐 값이 있으면 최신 값으로 한 번 더 보낸다. 빈 선택은 저장하지 않는다. */
  const flush = useCallback((): Promise<boolean> => {
    if (loop.current) return loop.current;
    const run = async (): Promise<boolean> => {
      let ok = true;
      await Promise.resolve(); // loop.current 대입 뒤에 정리 코드가 돌도록 한 번 양보한다
      try {
        while (needSave.current && !bannerOn.current) {
          needSave.current = false;
          const ids = [...sel.current];
          if (ids.length === 0) continue;
          if (live.current) setSaving(true);
          try {
            await api.saveSelection(system, ids);
            lastSaved.current = ids;
            if (live.current) setSaveErr(null);
            if (!needSave.current && !timer.current && sameIds(ids, sel.current)) dirty.current = false;
          } catch (e) {
            ok = false;
            needSave.current = true; // 실패한 변경은 아직 저장 전이다. 다음 시도(변경·이동)가 다시 보낸다.
            if (live.current) setSaveErr(toErr(e));
            break;
          }
        }
      } finally {
        loop.current = null; if (live.current) setSaving(false);
        if (recheck.current) { recheck.current = false; checkRef.current(); }
      }
      return ok;
    };
    loop.current = run();
    return loop.current;
  }, [system]);
  flushRef.current = flush;

  const change_ = useCallback((next: Set<string>) => {
    apply(next);
    dirty.current = true;
    needSave.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (next.size === 0 || bannerOn.current) return; // 빈 선택은 저장하지 않고, 배너 중에는 선택이 끝날 때까지 저장하지 않는다
    timer.current = setTimeout(() => { timer.current = null; void flush(); }, SAVE_DEBOUNCE_MS);
  }, [apply, flush]);

  const listRef = useRef(list);
  listRef.current = list;
  const load = useCallback(async (what: "all" | "selection") => {
    try {
      const [l, s] = await Promise.all([what === "all" ? api.features(system) : Promise.resolve(null), api.selection(system)]);
      if (!live.current) return;
      setLoadErr(null);
      if (l) setList(l);
      const disk = s?.resolved ?? [];
      lastSaved.current = disk;
      const known = new Set((l ?? listRef.current)?.rows.map((r) => r.id));
      // 응답을 기다리는 사이 로컬 변경이 생겼으면 그 값을 지킨다. 디스크 값이 다르면 배너로 알린다.
      if (dirty.current) {
        if (what === "selection" && !sameIds(disk, sel.current)) setBanner(true);
        apply(new Set([...sel.current].filter((id) => known.has(id))));
        return;
      }
      apply(new Set(disk.filter((id) => known.has(id)))); // 카탈로그에 없는 id는 뺀다
    } catch (e) { if (live.current) setLoadErr(toErr(e)); }
  }, [system, apply, setBanner]);

  useEffect(() => { void load("all"); }, [load]);
  // 부제용 원본 이름. 못 읽어도 화면은 그대로 쓴다.
  useEffect(() => { api.overview(system).then((o) => { if (live.current) setOrigin(o.source[0] ? originLabel(o.source[0].origin) : null); }).catch(() => undefined); }, [system]);

  /** selection.json 이벤트: 시간과 무관하게 디스크 값을 읽어 마지막으로 아는 값과 비교한다. 같으면 우리 저장의 메아리다. */
  const checkExternal = useCallback(async () => {
    if (loop.current) { recheck.current = true; return; } // 저장 루프가 끝난 뒤 다시 확인한다
    const seq = ++checkSeq.current;
    try {
      const s = await api.selection(system);
      if (!live.current || seq !== checkSeq.current) return;
      const disk = s?.resolved ?? [];
      if (loop.current) { recheck.current = true; return; }
      if (lastSaved.current && sameIds(disk, lastSaved.current)) return;
      lastSaved.current = disk;
      if (sameIds(disk, sel.current)) return;
      if (dirty.current) setBanner(true); // 응답 사이에 바뀐 로컬 변경도 dirty로 본다
      else {
        const known = new Set(listRef.current?.rows.map((r) => r.id));
        apply(new Set(disk.filter((id) => known.has(id))));
      }
    } catch { /* 다음 이벤트가 다시 확인한다 */ }
  }, [system, apply, setBanner]);
  checkRef.current = () => { void checkExternal(); };

  // 외부 변경(workspace-changed). 마운트 이전 이벤트는 건너뛴다.
  const seen = useRef(change?.n ?? 0);
  useEffect(() => {
    if (!change || change.n === seen.current) return;
    seen.current = change.n;
    if (change.system !== null && change.system !== system) return;
    if (touched(change, "catalog.json")) { void load("all"); return; }
    if (touched(change, "selection.json")) void checkExternal();
  }, [change, system, load, checkExternal]);

  const reloadSelection = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null; needSave.current = false; dirty.current = false;
    setBanner(false); setSaveErr(null);
    void load("selection");
  };
  const keepMine = () => {
    setBanner(false);
    dirty.current = true; needSave.current = true;
    void flush();
  };

  const openFeature = (id: string) => {
    setOpenId(id);
    setDetail({ id });
    api.feature(system, id).then((feature) => setDetail((d) => (d?.id === id ? { id, feature } : d))).catch((e: unknown) => setDetail((d) => (d?.id === id ? { id, error: toErr(e) } : d)));
  };

  const next = async () => {
    if (bannerOn.current) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (dirty.current) needSave.current = true; // 저장이 실패했던 변경도 다시 보낸다
    if (needSave.current || loop.current) { if (!(await flush())) return; } // 실패하면 오류를 남기고 이동하지 않는다
    go(pathFor("generate", system));
  };

  const methods = useMemo(() => [...new Set((list?.rows ?? []).map((r) => r.method))], [list]);
  const totals = useMemo(() => { const m = new Map<string, number>(); for (const r of list?.rows ?? []) m.set(r.group, (m.get(r.group) ?? 0) + 1); return m; }, [list]);
  const visible = useMemo(() => filterRows(list?.rows ?? [], { q, method, group }), [list, q, method, group]);

  return (
    <>
      <main className="panel mid sel-mid">
        {header}
        {list ? <p className="muted sel-sub">{[system, origin, `기능 ${list.total}개`].filter(Boolean).join(" · ")}</p> : null}
        {loadErr ? <Notice message={loadErr.message} hint={loadErr.hint} /> : null}
        {saveErr ? <Notice message={saveErr.message} hint={saveErr.hint ?? "선택은 화면에 그대로 있어요. 바꾸면 다시 저장해요."} /> : null}
        {banner ? (
          <div role="status" className="ft-banner">
            <span>다른 곳에서 선택이 바뀌었어요. 어느 쪽을 쓸지 골라 주세요.</span>
            <span className="ft-banner-btns">
              <button type="button" className="btn-ghost" onClick={keepMine}>내 선택 유지</button>
              <button type="button" className="btn-ghost" onClick={reloadSelection}>다시 불러오기</button>
            </span>
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
              <button type="button" className="btn-ghost" onClick={() => change_(toggleAll(visible, selected))}>
                {visible.length > 0 && visible.every((r) => selected.has(r.id)) ? "전체 해제" : "전체 선택"}
              </button>
              <select aria-label="그룹 필터" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">전체 그룹</option>
                {list.groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div className="ft-scroll">
              {visible.length === 0 ? <p className="muted">조건에 맞는 기능이 없어요.</p> : (
                <FeatureTable rows={visible} totals={totals} selected={selected} collapsed={collapsed} openId={openId} onSelect={change_} onOpen={openFeature}
                  onToggleCollapse={(g) => setCollapsed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })} />
              )}
            </div>
            <SelectionBar count={selected.size} saving={saving} hold={banner} onNext={() => void next()} />
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
