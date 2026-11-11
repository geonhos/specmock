/**
 * body 스키마가 "선택"인지 판정한다. `type: object`이고 `properties`가 있는데 `required`가 비어 있을 때만 선택이다
 * (모든 속성이 선택이라 빈 body도 유효). array · `oneOf`/`allOf` · properties 없는 body는 기존처럼 필수로 본다.
 */
export function isBodyRequired(body: Record<string, unknown> | null | undefined): boolean {
  if (!body) return false;
  const props = body.properties;
  const hasProps = body.type === "object" && typeof props === "object" && props !== null && !Array.isArray(props) && Object.keys(props).length > 0;
  if (!hasProps) return true;
  return Array.isArray(body.required) && body.required.length > 0;
}
