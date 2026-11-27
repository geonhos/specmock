import { expect, it } from "vitest";
import { parseRoute, pathFor } from "../src/route";

it("경로를 화면으로 푼다", () => {
  expect(parseRoute("/new")).toEqual({ screen: "new" });
  expect(parseRoute("/systems/a%20b/flows")).toEqual({ screen: "flows", system: "a b" });
  expect(parseRoute("/systems/gh/select")).toEqual({ screen: "home" }); // 6단계 화면 경로는 더 없다
  expect(parseRoute("/systems/%/flows")).toEqual({ screen: "home" });
  expect(pathFor("flows", "a b")).toBe("/systems/a%20b/flows");
});
