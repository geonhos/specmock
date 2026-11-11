import { describe, expect, it } from "vitest";
import { encodeForm } from "../src/verify/formEncode.js";

describe("encodeForm", () => {
  it("평면 · 숫자 · boolean", () => {
    expect(encodeForm({ amount: 1000, currency: "usd", confirm: true })).toBe("amount=1000&currency=usd&confirm=true");
  });
  it("중첩 object는 대괄호", () => {
    expect(encodeForm({ shipping: { address: { city: "Seoul" } } })).toBe("shipping%5Baddress%5D%5Bcity%5D=Seoul");
  });
  it("배열은 인덱스, 배열 안 object", () => {
    expect(encodeForm({ expand: ["a", "b"], items: [{ price: "p", quantity: 2 }] })).toBe(
      "expand%5B0%5D=a&expand%5B1%5D=b&items%5B0%5D%5Bprice%5D=p&items%5B0%5D%5Bquantity%5D=2",
    );
  });
  it("null · 빈 object · 빈 배열은 생략", () => {
    expect(encodeForm({ a: null, b: {}, c: [], d: "x" })).toBe("d=x");
  });
  it("공백과 한글은 URLSearchParams 인코딩", () => {
    expect(encodeForm({ name: "Jenny Rosen", memo: "한글" })).toBe("name=Jenny+Rosen&memo=%ED%95%9C%EA%B8%80");
  });
});
