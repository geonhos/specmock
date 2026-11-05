import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z, type ZodType } from "zod";

function assertSystemName(system: string): void {
  if (!/^[\p{L}\p{N}_-]+$/u.test(system)) {
    throw new Error(`시스템 이름이 올바르지 않습니다: '${system}' (문자·숫자·-·_ 만 사용)`);
  }
}

const PRODUCER: Record<string, string> = {
  "source.json": "specmock ingest",
  "catalog.json": "specmock analyze",
  "selection.json": "specmock select",
  "mockspec.json": "specmock select",
};

export class Workspace {
  constructor(readonly root: string = path.resolve(".specmock")) {}

  dir(system: string): string {
    assertSystemName(system);
    return path.join(this.root, system);
  }

  file(system: string, name: string): string {
    return path.join(this.dir(system), name);
  }

  async exists(system: string, name: string): Promise<boolean> {
    try {
      await access(this.file(system, name));
      return true;
    } catch {
      return false;
    }
  }

  async read<T>(system: string, name: string, schema: ZodType<T>): Promise<T> {
    const file = this.file(system, name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const hint = PRODUCER[name] ? ` 먼저 \`${PRODUCER[name]} ${system}\`를 실행하세요.` : "";
      throw new Error(`${name} 파일이 없습니다 (${file}).${hint}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${file}: JSON 파싱 실패. ${(e as Error).message}`);
    }
    const result = schema.safeParse(json);
    if (!result.success) throw new Error(`${file}: 형식 오류\n${z.prettifyError(result.error)}`);
    return result.data;
  }

  async write<T>(system: string, name: string, schema: ZodType<T>, data: T): Promise<string> {
    const file = this.file(system, name);
    const result = schema.safeParse(data);
    if (!result.success) throw new Error(`${file}: 형식 오류\n${z.prettifyError(result.error)}`);
    const validated = result.data;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(validated, null, 2) + "\n", "utf8");
    return file;
  }

  async writeText(system: string, name: string, text: string): Promise<string> {
    const file = this.file(system, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
    return file;
  }
}
