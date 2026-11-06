import { describe, expect, it } from "vitest";
import { LockBusyError } from "@specmock/core";
import { toApiError, toUiHint } from "../src/errors.js";

describe("toApiError", () => {
  it.each([
    [new Error("catalog.json 파일이 없습니다 (/x/catalog.json). 먼저 `specmock analyze pets`를 실행하세요."), 404, "not-found"],
    [new Error("시스템 이름이 올바르지 않습니다: 'a b' (문자·숫자·-·_ 만 사용)"), 400, "invalid"],
    [new Error("알 수 없는 기능 id: x.get"), 400, "invalid"],
    [new Error("/m은(는) specmock이 만든 디렉터리가 아닙니다(specmock.lock.json 없음). 덮어쓰려면 --force"), 409, "overwrite-required"],
    [new LockBusyError("/x/.lock", null), 409, "busy"],
    [new DOMException("취소", "AbortError"), 499, "cancelled"],
    [new Error("뭔가 깨짐"), 500, "failed"],
  ])("%s → %d %s", (e, status, code) => {
    const r = toApiError(e);
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ ok: false, error: { code } });
  });

  it("hint의 CLI 명령을 화면 동작 이름으로 바꾸고 message에서는 뺀다", () => {
    const r = toApiError(new Error("catalog.json 파일이 없습니다 (/x). 먼저 `specmock analyze pets`를 실행하세요."));
    expect(r.body.error.hint).toBe("먼저 ② 분석을 진행해 주세요.");
    expect(r.body.error.message).not.toContain("specmock analyze");
  });

  it("busy의 hint", () => {
    expect(toApiError(new LockBusyError("/x/.lock", null)).body.error.hint).toBe("다른 곳(CLI/대화)에서 작업 중이에요. 끝난 뒤 다시 시도해 주세요.");
  });
});

describe("toUiHint", () => {
  it.each([
    ["먼저 specmock generate pets 을 실행하거나 --dir 로 경로를 지정하세요.", "먼저 ④ 생성을 진행하거나 출력 디렉터리를 지정해 주세요."],
    ["먼저 specmock select pets <표현식>을 실행하세요.", "먼저 ③ 기능 선택을 진행해 주세요."],
  ])("%s", (input, expected) => { expect(toUiHint(input)).toBe(expected); });
});
