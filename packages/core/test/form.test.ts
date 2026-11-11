import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { renderTsHonoFiles } from "../src/generate/tsHono.js";
import { encodeForm } from "../src/verify/formEncode.js";
import type { MockSpec } from "../src/types.js";

let parseForm: (text: string) => Record<string, unknown>;

beforeAll(async () => {
  // form.ts는 템플릿 변수가 없어 어떤 스펙으로 렌더해도 내용이 같다.
  const spec = { system: "t", features: [], notMocked: [] } as unknown as MockSpec;
  const file = renderTsHonoFiles(spec).find((f) => f.path === "src/form.ts");
  expect(file).toBeDefined();
  const js = ts.transpileModule(file!.content, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "specmock-form-"));
  writeFileSync(join(dir, "form.mjs"), js);
  ({ parseForm } = await import(pathToFileURL(join(dir, "form.mjs")).href));
});

describe("parseForm", () => {
  it("평면 키", () => {
    expect(parseForm("amount=1000&currency=usd")).toEqual({ amount: "1000", currency: "usd" });
  });
  it("대괄호 중첩", () => {
    expect(parseForm("shipping[address][city]=Seoul")).toEqual({ shipping: { address: { city: "Seoul" } } });
  });
  it("빈 대괄호는 배열", () => {
    expect(parseForm("expand[]=customer&expand[]=invoice")).toEqual({ expand: ["customer", "invoice"] });
  });
  it("숫자 세그먼트는 배열(인덱스 순)", () => {
    expect(parseForm("items[1]=b&items[0]=a")).toEqual({ items: ["a", "b"] });
  });
  it("배열 안 object", () => {
    expect(parseForm("line_items[0][price]=p_1&line_items[0][quantity]=2")).toEqual({
      line_items: [{ price: "p_1", quantity: "2" }],
    });
  });
  it("같은 키 반복은 배열", () => {
    expect(parseForm("tag=a&tag=b")).toEqual({ tag: ["a", "b"] });
  });
  it("+ 와 퍼센트 인코딩", () => {
    expect(parseForm("name=Jenny+Rosen&memo=%ED%95%9C%EA%B8%80")).toEqual({ name: "Jenny Rosen", memo: "한글" });
  });
  it("__proto__ · constructor · prototype 세그먼트는 무시", () => {
    const r = parseForm("__proto__[polluted]=1&a[constructor][x]=1&b=2");
    expect(r).toEqual({ b: "2" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("깊이 32 초과 쌍은 무시", () => {
    const deep = "a" + "[b]".repeat(40) + "=1&c=1";
    expect(parseForm(deep)).toEqual({ c: "1" });
  });
  it("인덱스 1000은 받고 1001·4294967294는 무시", () => {
    expect(parseForm("a[1000]=x")).toEqual({ a: ["x"] });
    expect(parseForm("a[1001]=x")).toEqual({});
    expect(parseForm("a[4294967294]=x")).toEqual({});
  });
  it("거대한 인덱스도 즉시 끝난다", () => {
    const t0 = performance.now();
    parseForm("a[4294967294]=x&b[100000000]=y");
    expect(performance.now() - t0).toBeLessThan(50);
  });
  it("빈 문자열은 빈 객체", () => {
    expect(parseForm("")).toEqual({});
  });
  it("값은 변환하지 않는다(문자열 유지)", () => {
    expect(parseForm("flag=true&n=1")).toEqual({ flag: "true", n: "1" });
  });
  it("encodeForm 왕복: 모든 leaf가 문자열로 돌아온다", () => {
    expect(parseForm(encodeForm({ a: { b: 1 }, c: [true, "x"] }))).toEqual({ a: { b: "1" }, c: ["true", "x"] });
  });
});
