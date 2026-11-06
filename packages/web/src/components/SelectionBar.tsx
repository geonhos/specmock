export function SelectionBar({ count, saving, onNext }: { count: number; saving: boolean; onNext: () => void }) {
  const empty = count === 0;
  return (
    <div className="ft-cta">
      <div className="ft-cnt">
        <strong>{count}개 선택</strong>
        {empty
          ? <span id="select-why">하나 이상 골라 주세요</span>
          : <span>{saving ? "저장하는 중…" : "자동 저장"}</span>}
      </div>
      {empty ? <span className="ft-why text-3">비어 있는 선택은 저장하지 않아요.</span> : null}
      <button type="button" className="btn-primary" disabled={empty} aria-describedby={empty ? "select-why" : undefined} onClick={onNext}>mock 만들기</button>
    </div>
  );
}
