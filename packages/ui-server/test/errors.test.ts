import { describe, expect, it } from "vitest";
import { LockBusyError } from "@specmock/core";
import { ingestInputError, InvalidRequest, toApiError, toUiHint } from "../src/errors.js";

describe("toApiError", () => {
  it.each([
    [new Error("catalog.json 파일이 없습니다 (/x/catalog.json). 먼저 `specmock analyze pets`를 실행하세요."), 404, "not-found"],
    [new Error("시스템 이름이 올바르지 않습니다: 'a b' (문자·숫자·-·_ 만 사용)"), 400, "invalid"],
    [new Error("알 수 없는 기능 id: x.get"), 400, "invalid"],
    [new Error("/m은(는) specmock이 만든 디렉터리가 아닙니다(specmock.lock.json 없음). 덮어쓰려면 --force"), 409, "overwrite-required"],
    [new LockBusyError("/x/.lock", null), 409, "busy"],
    [new DOMException("취소", "AbortError"), 499, "cancelled"],
    [new Error("뭔가 깨짐"), 500, "failed"],
    [new Error("/w/pets/catalog.json: 형식 오류\n✖ Invalid input"), 500, "failed"],
    [new Error("/w/pets/source.json: JSON 파싱 실패. Unexpected token"), 500, "failed"],
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

describe("ingestInputError", () => {
  const errno = (code: string, p: string) => Object.assign(new Error(`${code}: x, open '${p}'`), { code, path: p });
  it.each([
    ["ENOENT", "파일을 찾을 수 없어요: /nope/a.yaml"],
    ["EISDIR", "파일이 아니라 디렉터리예요: /nope/a.yaml"],
    ["ENOTDIR", "경로가 올바르지 않아요: /nope/a.yaml"],
    ["EACCES", "파일을 읽을 권한이 없어요: /nope/a.yaml"],
  ])("%s → InvalidRequest(%s)", (code, message) => {
    const e = ingestInputError(errno(code, "/nope/a.yaml"));
    expect(e).toBeInstanceOf(InvalidRequest);
    expect((e as Error).message).toBe(message);
    expect(toApiError(e).status).toBe(400);
  });
  it("URL 요청 실패는 400 invalid로, 원문 메시지를 유지", () => {
    const e = ingestInputError(new Error("http://127.0.0.1:1/x 요청 실패: ECONNREFUSED"));
    expect(toApiError(e)).toMatchObject({ status: 400, body: { error: { code: "invalid", message: "http://127.0.0.1:1/x 요청 실패: ECONNREFUSED" } } });
  });
  it("그 밖의 오류는 그대로 돌려준다", () => {
    const e = new Error("뭔가 깨짐");
    expect(ingestInputError(e)).toBe(e);
  });
});
