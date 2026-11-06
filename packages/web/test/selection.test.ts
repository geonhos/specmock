import { expect, it } from "vitest";
import { filterRows, groupState, splitPathVars, toggleAll, toggleGroup } from "../src/selection";

const rows = [
  { id: "pets.list", group: "pets", method: "GET", path: "/pets", summary: "목록" },
  { id: "pets.create", group: "pets", method: "POST", path: "/pets", summary: "등록" },
  { id: "store.inv", group: "store", method: "GET", path: "/store/inventory", summary: "재고" },
] as const;

it("그룹 3상태", () => {
  expect(groupState(rows, "pets", new Set())).toBe("none");
  expect(groupState(rows, "pets", new Set(["pets.list"]))).toBe("some");
  expect(groupState(rows, "pets", new Set(["pets.list", "pets.create"]))).toBe("all");
});
it("그룹 토글: none/some → all, all → none (보이는 행만)", () => {
  expect([...toggleGroup(rows, "pets", new Set(["pets.list"]))].sort()).toEqual(["pets.create", "pets.list"]);
  expect([...toggleGroup(rows, "pets", new Set(["pets.list", "pets.create", "store.inv"]))]).toEqual(["store.inv"]);
});
it("검색 중 그룹 토글은 보이지 않는 행을 건드리지 않는다", () => {
  const visible = filterRows(rows, { method: "POST" });
  expect([...toggleGroup(visible, "pets", new Set(["pets.list"]))].sort()).toEqual(["pets.create", "pets.list"]);
  expect([...toggleGroup(visible, "pets", new Set(["pets.list", "pets.create"]))]).toEqual(["pets.list"]);
});
it("검색(경로·요약·id, 대소문자 무시) + 그룹·메서드 필터", () => {
  expect(filterRows(rows, { q: "INVEN" }).map((r) => r.id)).toEqual(["store.inv"]);
  expect(filterRows(rows, { q: "목록" }).map((r) => r.id)).toEqual(["pets.list"]);
  expect(filterRows(rows, { q: "pets.create" }).map((r) => r.id)).toEqual(["pets.create"]);
  expect(filterRows(rows, { method: "POST" }).map((r) => r.id)).toEqual(["pets.create"]);
  expect(filterRows(rows, { group: "store", q: "pets" })).toEqual([]);
});
it("summary 없는 행도 검색된다", () => {
  expect(filterRows([{ id: "a", group: "g", method: "GET", path: "/Abc" }], { q: "abc" })).toHaveLength(1);
});
it("경로 변수 나누기", () => {
  expect(splitPathVars("/pets/{petId}/photos")).toEqual([
    { text: "/pets/", v: false }, { text: "{petId}", v: true }, { text: "/photos", v: false },
  ]);
  expect(splitPathVars("/pets")).toEqual([{ text: "/pets", v: false }]);
});
it("전체 토글: 보이는 행이 모두 선택이면 해제, 아니면 모두 선택, 보이지 않는 행은 그대로", () => {
  const visible = filterRows(rows, { method: "GET" });
  expect([...toggleAll(visible, new Set(["pets.create"]))].sort()).toEqual(["pets.create", "pets.list", "store.inv"]);
  expect([...toggleAll(visible, new Set(["pets.create", "pets.list", "store.inv"]))]).toEqual(["pets.create"]);
  expect([...toggleAll([], new Set(["a"]))]).toEqual(["a"]);
});
