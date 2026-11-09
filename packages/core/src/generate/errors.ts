// packages/core/src/generate/errors.ts
/** LLM 생성이 maxAttempts 안에 검증을 통과하지 못했다. CLI 종료 코드 5. */
export class GenerationFailedError extends Error {
  readonly exitCode = 5;
  constructor(readonly attempts: number, readonly attemptDir: string, readonly lastErrors: string[]) {
    super(`${attempts}번 시도했지만 검증을 통과하는 mock을 만들지 못했습니다. 마지막 시도: ${attemptDir} (errors.md 참고)`);
    this.name = "GenerationFailedError";
  }
}

/** 재시도해도 소용없는 환경 문제(JDK·네트워크·claude CLI 없음). CLI 종료 코드 1. */
export class EnvironmentError extends Error {
  readonly exitCode = 1;
  constructor(readonly requires: string, readonly detail: string) {
    super(`${requires}가 필요합니다: ${detail}`);
    this.name = "EnvironmentError";
  }
}
