import { InvalidRequest } from "./errors.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_VALUE_MAX = 4096;

/** 화면에서 입력한 환경 변수 값을 시스템별로 서버 메모리에만 둔다. 파일·응답·로그·이벤트에 싣지 않는다. 서버가 꺼지면 사라진다. */
export class EnvStore {
  readonly #m = new Map<string, Record<string, string>>();

  /** 빈 문자열 값은 삭제. 규칙을 어기면 아무것도 바꾸지 않고 InvalidRequest. 오류 메시지에 값은 싣지 않는다. */
  set(system: string, values: Record<string, string>): string[] {
    for (const [k, v] of Object.entries(values)) {
      if (!NAME.test(k)) throw new InvalidRequest(`환경 변수 이름이 규칙에 맞지 않습니다: ${k.slice(0, 64)}`);
      if (v.length > ENV_VALUE_MAX) throw new InvalidRequest(`환경 변수 값이 너무 깁니다(${ENV_VALUE_MAX}자 이하): ${k}`);
    }
    const cur = { ...(this.#m.get(system) ?? {}) };
    for (const [k, v] of Object.entries(values)) {
      if (v === "") delete cur[k]; else cur[k] = v;
    }
    this.#m.set(system, cur);
    return Object.keys(cur);
  }

  names(system: string): string[] { return Object.keys(this.#m.get(system) ?? {}); }

  /** record 작업에 넘길 환경: 서버 프로세스 env 위에 화면 입력값을 덮는다. */
  env(system: string): Record<string, string | undefined> { return { ...process.env, ...(this.#m.get(system) ?? {}) }; }
}
