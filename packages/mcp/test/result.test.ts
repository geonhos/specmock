import { describe, expect, it } from "vitest";
import { rewriteHints, toolError } from "../src/result.js";

describe("rewriteHints", () => {
  it("replaces CLI commands in core messages with tool names", () => {
    expect(rewriteHints("catalog.json 파일이 없습니다 (/p). 먼저 `specmock analyze pets`를 실행하세요."))
      .toBe("catalog.json 파일이 없습니다 (/p). 먼저 `analyze_spec`를 실행하세요.");
    expect(rewriteHints("/m 이(가) 없습니다. 먼저 specmock generate pets 을 실행하거나 --dir 로 경로를 지정하세요."))
      .toBe("/m 이(가) 없습니다. 먼저 `generate_mock` 을 실행하거나 dir 인자로 경로를 지정하세요.");
    expect(rewriteHints("먼저 `specmock ingest x`를")).toBe("먼저 `ingest_spec`를");
    expect(rewriteHints("먼저 `specmock select x`를")).toBe("먼저 `select_features`를");
  });
  it("leaves other text alone", () => {
    expect(rewriteHints("알 수 없는 기능 id: x")).toBe("알 수 없는 기능 id: x");
  });
  it("toolError marks isError and keeps the message", () => {
    expect(toolError(new Error("boom"))).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });
});
