import type { SystemSummary } from "@specmock/ui-server/api-types";
import { pathFor, STEP_SCREENS, type Screen } from "../route";

const LABELS = ["① 등록", "② 분석", "③ 기능 선택", "④ 생성", "⑤ 검증"];
const STALE_KEY: (keyof SystemSummary["stale"] | null)[] = [null, null, "select", "generate", "verify"];

/** 단계 n에 갈 수 있는지: 앞 단계를 끝냈거나, 이미 끝낸 단계. */
function reachable(s: SystemSummary | undefined, i: number): boolean {
  if (i === 0) return true;
  if (!s) return false;
  const done = [s.steps.registered, s.steps.analyzed, s.steps.selected, s.steps.generated, s.steps.verified];
  return done[i] === true || done[i - 1] === true;
}

export function StepBar({ system, screen, go }: { system?: SystemSummary; screen: Screen; go: (path: string) => void }) {
  return (
    <header className="topbar">
      <span className="logo">specmock</span>
      <ol className="steps" aria-label="단계">
        {STEP_SCREENS.map((sc, i) => {
          const ok = reachable(system, i);
          const stale = system && STALE_KEY[i] ? system.stale[STALE_KEY[i]!] : false;
          const cls = `step${screen === sc ? " cur" : ""}${system && [system.steps.registered, system.steps.analyzed, system.steps.selected, system.steps.generated, system.steps.verified][i] ? " done" : ""}`;
          const inner = (<><span>{LABELS[i]}</span>{stale ? <small className="stale">다시 실행 필요</small> : null}</>);
          return (
            <li key={sc}>
              {ok
                ? <button type="button" className={cls} aria-current={screen === sc ? "step" : undefined} onClick={() => go(pathFor(sc, system?.name))}>{inner}</button>
                : <span className={cls} aria-disabled="true">{inner}</span>}
            </li>
          );
        })}
      </ol>
    </header>
  );
}
