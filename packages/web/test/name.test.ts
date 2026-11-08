import { expect, it } from "vitest";
import { suggestSystemName } from "../src/name";

it("파일은 확장자를 뺀 basename, URL은 hostname, 허용 밖 글자는 -, 소문자", () => {
  expect(suggestSystemName("/x/docs/petstore.yaml")).toBe("petstore");
  expect(suggestSystemName("docs/Pets API.v2.md")).toBe("pets-api-v2");
  expect(suggestSystemName("C:\\specs\\billing.json")).toBe("billing");
  expect(suggestSystemName("https://api.example.com/openapi.json")).toBe("api-example-com");
  expect(suggestSystemName("한글_문서.pdf")).toBe("한글_문서");
});

it("비었거나 URL을 못 읽으면 빈 문자열", () => {
  expect(suggestSystemName("")).toBe("");
  expect(suggestSystemName("   ")).toBe("");
  expect(suggestSystemName("https://")).toBe("");
});
