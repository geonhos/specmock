import { expect, it } from "vitest";
import { parseRoute } from "../src/route";

it("경로를 화면으로 푼다", () => {
  expect(parseRoute("/new")).toEqual({ screen: "new" });
  expect(parseRoute("/systems/a%20b/select")).toEqual({ screen: "select", system: "a b" });
  expect(parseRoute("/nope")).toEqual({ screen: "home" });
});

it("잘못된 % 인코딩은 던지지 않고 홈", () => {
  expect(parseRoute("/systems/%E0%A4%A/analyze")).toEqual({ screen: "home" });
  expect(parseRoute("/systems/%/verify")).toEqual({ screen: "home" });
});
