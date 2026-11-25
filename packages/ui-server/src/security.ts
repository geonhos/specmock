import type { MiddlewareHandler } from "hono";
import { errorBody } from "./errors.js";

/** 로컬 전용: Host가 127.0.0.1:<port>/localhost:<port>가 아니거나, Origin이 같은 출처가 아니면 거부(DNS 리바인딩·다른 사이트 요청 차단). */
export function localOnly(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    const p = port();
    const allowed = [`127.0.0.1:${p}`, `localhost:${p}`];
    // Host와 Origin은 각각 로컬 허용 목록으로만 검사한다. Host 127.0.0.1 + Origin localhost 같은
    // 교차 조합도 둘 다 이 컴퓨터를 가리키므로 허용한다(리바인딩·타 사이트 요청은 어느 쪽이든 걸러진다).
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (!allowed.includes(host) || (origin !== undefined && !allowed.some((h) => origin === `http://${h}`))) {
      return c.json(errorBody("forbidden", "이 화면은 이 컴퓨터의 브라우저에서만 열 수 있어요."), 403);
    }
    await next();
  };
}

const POST_ONLY = /^\/api\/(?:systems\/[^/]+\/(?:analyze|extract|generate|verify|record|env)|jobs\/[^/]+\/cancel)\/?$/;
const TARGET_PATH = /^\/api\/systems\/[^/]+\/target\/?$/;

/** 이 API는 GET·POST와 `target`의 PUT만 쓴다. 그 밖의 메서드, POST 전용 경로의 GET, `target`의 POST는 405. */
export const methodGuard: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  const readOnly = m === "GET" || m === "HEAD";
  const path = c.req.path;
  let allow: string | null = null;
  if (POST_ONLY.test(path)) { if (m !== "POST") allow = "POST"; }
  else if (TARGET_PATH.test(path)) { if (!readOnly && m !== "PUT") allow = "GET, PUT"; }
  else if (!readOnly && m !== "POST") allow = "GET, POST";
  if (allow !== null) return c.json(errorBody("invalid", `허용하지 않는 메서드예요: ${m} ${path}`), 405, { allow });
  await next();
};
