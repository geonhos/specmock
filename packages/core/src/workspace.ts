import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";

const PRODUCER: Record<string, string> = {
  "source.json": "specmock ingest",
  "catalog.json": "specmock analyze",
  "selection.json": "specmock select",
  "mockspec.json": "specmock select",
};

export class Workspace {
  constructor(readonly root: string = path.resolve(".specmock")) {}

  dir(system: string): string {
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
    } catch {
      const hint = PRODUCER[name] ? ` 먼저 \`${PRODUCER[name]} ${system}\`를 실행하세요.` : "";
      throw new Error(`${name} 파일이 없습니다 (${file}).${hint}`);
    }
    return schema.parse(JSON.parse(text));
  }

  async write<T>(system: string, name: string, schema: ZodType<T>, data: T): Promise<string> {
    const file = this.file(system, name);
    await mkdir(path.dirname(file), { recursive: true });
    const validated = schema.parse(data);
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
