import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import type { TargetChoice } from "../screens/Flows";

const CHOICES: [TargetChoice, string][] = [["mock", "mock"], ["real", "실제"], ["both", "둘 다"]];

export function FlowTopBar(p: { name: string; target: TargetChoice; onTarget: (t: TargetChoice) => void; cleanup: boolean; onCleanup: (on: boolean) => void;
  safety: boolean | null; onSafety: () => void; running: boolean; cancellable: boolean; blocked: boolean; onRun: () => void; onCancel: () => void }) {
  return (
    <>
      {/* Toolbar takes no className, so the safety colour goes on this wrapper. */}
      <div className="flow-bar" data-safety={p.safety === null ? "unknown" : p.safety ? "on" : "off"}>
        <Toolbar label="흐름 실행"
          startContent={
            <>
              <h2>{p.name}</h2>
              <SegmentedControl label="대상" value={p.target} onChange={(v) => p.onTarget(v as TargetChoice)}>
                {CHOICES.map(([v, label]) => <SegmentedControlItem key={v} value={v} label={label} />)}
              </SegmentedControl>
            </>
          }
          endContent={
            <>
              <CheckboxInput label="정리" value={p.cleanup} onChange={(on) => p.onCleanup(on === true)} />
              {p.running && p.cancellable ? <Button variant="secondary" label="실행 취소" onClick={p.onCancel} /> : null}
              <Button variant="primary" label="전체 실행" isDisabled={p.running || p.blocked} onClick={p.onRun} />
              <Switch label="안전장치" value={p.safety === true} isDisabled={p.safety === null} onChange={() => p.onSafety()} />
            </>
          } />
      </div>
      {p.safety === false ? <Banner status="warning" title="실제 서버에 변경 요청을 보냅니다" description="안전장치가 꺼져 있어 실제 대상에는 쓰기 요청도 갑니다." /> : null}
    </>
  );
}
