import type { MiddlewareHandler } from "hono";
import { errorBody } from "./errors.js";

/** 로컬 전용: Host가 127.0.0.1:<port>/localhost:<port>가 아니거나, Origin이 같은 출처가 아니면 거부(DNS 리바인딩·다른 사이트 요청 차단). */
export function localOnly(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    const p = port();
    const allowed = [`127.0.0.1:${p}`, `localhost:${p}`];
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (!allowed.includes(host) || (origin !== undefined && !allowed.some((h) => origin === `http://${h}`))) {
      return c.json(errorBody("forbidden", "이 화면은 이 컴퓨터의 브라우저에서만 열 수 있어요."), 403);
    }
    await next();
  };
}

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const POST_ONLY = /^\/api\/(?:systems\/[^/]+\/(?:analyze|extract|generate|verify)|jobs\/[^/]+\/cancel)\/?$/;

/** 이 API는 GET·POST만 쓴다. PUT·PATCH·DELETE 등과, POST 전용 경로의 GET은 405. */
export const methodGuard: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  const postOnlyViolation = (m === "GET" || m === "HEAD") && POST_ONLY.test(c.req.path);
  if (!ALLOWED_METHODS.has(m) || postOnlyViolation) {
    const allow = POST_ONLY.test(c.req.path) ? "POST" : "GET, POST";
    return c.json(errorBody("invalid", `허용하지 않는 메서드예요: ${m} ${c.req.path}`), 405, { allow });
  }
  await next();
};
