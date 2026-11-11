// packages/core/src/generate/glob.ts
/**
 * 아주 작은 glob. `**`(여러 세그먼트, 0개 포함), `*`(한 세그먼트 안), 나머지는 글자 그대로.
 * `dir/**`는 `dir` 자체와도, 맨 앞의 `**` 뒤에 `/x`가 오는 패턴은 루트의 `x`와도 맞는다. 경로 구분자는 `/`만 쓴다.
 */
export function matchGlob(pattern: string, rel: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (i === 0 && pattern[2] === "/") { re += "(?:.*/)?"; i += 2; continue; }
      if (pattern[i - 1] === "/" && re.endsWith("/")) re = re.slice(0, -1) + "(?:/.*)?";
      else re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(rel);
}

export const matchesAny = (patterns: string[], rel: string) => patterns.some((p) => matchGlob(p, rel));
