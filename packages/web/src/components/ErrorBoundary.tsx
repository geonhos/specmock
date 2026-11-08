import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; onReload?: () => void }

/** 화면을 그리다 난 오류를 잡아 안내와 새로고침 버튼을 보인다. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <p><strong>화면에 문제가 생겼어요</strong></p>
        <p className="notice-hint">새로고침하면 대부분 해결돼요.</p>
        <button type="button" className="btn-primary" onClick={this.props.onReload ?? (() => window.location.reload())}>새로고침</button>
      </div>
    );
  }
}
