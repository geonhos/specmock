import { useEffect, useRef, type ReactNode } from "react";

interface Props { open: boolean; title: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void; children?: ReactNode }

/**
 * 브라우저에서는 showModal()로 연다(aria-modal·포커스 가두기·Esc가 따라온다).
 * jsdom처럼 showModal이 없으면 open 속성으로 대신 열고 Esc는 keydown으로 받는다.
 * 닫히면 연 요소로 포커스를 돌려주고, 배경(::backdrop) 클릭은 취소로 본다.
 */
export function ConfirmDialog(props: Props) {
  return props.open ? <Modal {...props} /> : null;
}

function Modal({ title, confirmLabel, onCancel, onConfirm, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const modal = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof el.showModal === "function") { el.showModal(); modal.current = true; } else el.setAttribute("open", "");
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus();
    return () => {
      if (el.open && typeof el.close === "function") el.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }} // 안쪽 클릭은 target이 자식이다. 배경 클릭만 dialog 자신
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onKeyDown={(e) => { if (e.key === "Escape" && !modal.current) onCancel(); }}
    >
      <div className="dialog-inner">
        <h2>{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>취소</button>
          <button type="button" className="btn-primary" onClick={onConfirm} data-autofocus>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}
