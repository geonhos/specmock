import { Ajv, type Options } from "ajv";
import addFormats from "ajv-formats";

/** verify(contract 검증)와 merge(LLM 스키마 컴파일 확인)가 같은 설정의 Ajv를 쓴다. */
export function makeAjv(options: Options = {}): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false, ...options });
  // ajv-formats는 CommonJS 모듈이라 NodeNext에서는 default import가 module.exports 전체를 가리킨다.
  addFormats.default(ajv);
  for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) ajv.addFormat(f, true);
  return ajv;
}
