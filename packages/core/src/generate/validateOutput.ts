// packages/core/src/generate/validateOutput.ts
import path from "node:path";
import { z } from "zod";
import { matchesAny } from "./glob.js";
import type { LanguageProfile } from "./profiles/types.js";

export const GeneratedOutputSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), content: z.string().nullable() })),
  notes: z.array(z.string()).default([]),
});
export type GeneratedOutput = z.infer<typeof GeneratedOutputSchema>;

export type ValidateResult =
  | { ok: true; files: GeneratedOutput["files"]; notes: string[] }
  | { ok: false; errors: string[] };

/** 모델 응답의 형식·경로·개수를 검사한다. 내용(컴파일 가능 여부)은 보지 않는다. */
export function validateOutput(raw: unknown, profile: LanguageProfile): ValidateResult {
  const parsed = GeneratedOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: [`응답 형식: ${z.prettifyError(parsed.error)}`] };
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of parsed.data.files) {
    if (/[\x00-\x1f\x7f]/.test(f.path)) { errors.push(`경로에 제어 문자가 있습니다: ${JSON.stringify(f.path)}`); continue; }
    const p = f.path.replace(/\\/g, "/");
    if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) { errors.push(`절대 경로는 쓸 수 없습니다: ${f.path}`); continue; }
    const norm = path.posix.normalize(p);
    if (norm === ".." || norm.startsWith("../")) { errors.push(`경로가 outDir을 벗어납니다: ${f.path}`); continue; }
    if (p.endsWith("/")) { errors.push(`디렉터리 경로는 쓸 수 없습니다: ${f.path}`); continue; }
    const key = norm.normalize("NFC").toLowerCase();
    if (seen.has(key)) errors.push(`같은 경로가 두 번 나옵니다: ${norm}`);
    seen.add(key);
    if (profile.sourceGlobs.some((g) => g.endsWith("/**") && g.slice(0, -3) === norm)) { errors.push(`디렉터리 경로는 쓸 수 없습니다: ${norm}`); continue; }
    if (matchesAny(profile.protectedPaths, norm)) errors.push(`보호 경로입니다: ${norm}`);
    else if (!matchesAny(profile.sourceGlobs, norm)) errors.push(`sourceGlobs 밖입니다: ${norm} (허용: ${profile.sourceGlobs.join(", ")})`);
  }
  if (parsed.data.files.length > profile.maxFiles) errors.push(`파일이 너무 많습니다: ${parsed.data.files.length}개 (최대 ${profile.maxFiles})`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, files: parsed.data.files.map((f) => ({ path: path.posix.normalize(f.path.replace(/\\/g, "/")), content: f.content })), notes: parsed.data.notes };
}

/** `claude --json-schema`에 넘길 출력 스키마. analyze의 extractionJsonSchema와 같은 변환. */
export function generatedOutputJsonSchema(): Record<string, unknown> {
  const js = z.toJSONSchema(GeneratedOutputSchema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
