/** hold: 외부 변경 배너가 떠 있어 어느 쪽을 쓸지 정하기 전에는 넘어가지 않는다. */
export function SelectionBar({ count, saving, hold = false, onNext }: { count: number; saving: boolean; hold?: boolean; onNext: () => void }) {
  const empty = count === 0;
  return (
    <div className="ft-cta">
      <div className="ft-cnt">
        <strong>{count}개 선택</strong>
        {empty
          ? <span id="select-why">하나 이상 골라 주세요</span>
          : <span>{hold ? "자동 저장 멈춤" : saving ? "저장하는 중…" : "자동 저장"}</span>}
      </div>
      {empty ? <span className="ft-why text-3">비어 있는 선택은 저장하지 않아요.</span> : null}
      {hold && !empty ? <span id="select-hold" className="ft-why text-3">위 알림에서 어느 선택을 쓸지 먼저 골라 주세요.</span> : null}
      <button type="button" className="btn-primary" disabled={empty || hold} aria-describedby={empty ? "select-why" : hold ? "select-hold" : undefined} onClick={onNext}>mock 만들기</button>
    </div>
  );
}
