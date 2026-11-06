import type { ReactNode } from "react";

interface Props { open: boolean; title: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void; children?: ReactNode }

/** <dialog>를 open 속성으로 직접 연다(jsdom은 showModal이 없다). 배경 클릭·Esc는 취소로 본다. */
export function ConfirmDialog({ open, title, confirmLabel, onCancel, onConfirm, children }: Props) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <dialog open aria-label={title} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
        <h2>{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>취소</button>
          <button type="button" className="btn-primary" onClick={onConfirm} autoFocus>{confirmLabel}</button>
        </div>
      </dialog>
    </div>
  );
}
