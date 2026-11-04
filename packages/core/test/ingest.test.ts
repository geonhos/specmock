import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectKind, ingest } from "../src/ingest/index.js";
import { SourceSchema } from "../src/types.js";
import { Workspace } from "../src/workspace.js";
import { CIRCULAR, PETSTORE } from "./helpers.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "specmock-ingest-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("detectKind", () => {
  it("detects openapi by content", () => {
    expect(detectKind("spec.yaml", "openapi: 3.0.0\npaths: {}")).toBe("openapi");
    expect(detectKind("spec.json", '{"swagger":"2.0"}')).toBe("openapi");
  });
  it("does not misdetect prose that mentions openapi", () => {
    expect(detectKind("README.md", "Our spec uses openapi: 3.1 conventions")).toBe("markdown");
    expect(detectKind("ci.yaml", "jobs:\n  swagger:\n    run: x")).toBe("text");
    expect(detectKind("spec.json", '{"openapi":"3.0.0","paths":{}}')).toBe("openapi");
    expect(detectKind("https://x.test/openapi?x=1#frag", "openapi: 3.0.0\npaths: {}")).toBe("openapi");
  });
  it("falls back to markdown/text by extension", () => {
    expect(detectKind("README.md", "# hi")).toBe("markdown");
    expect(detectKind("notes.txt", "hi")).toBe("text");
  });
});

describe("ingest(openapi)", () => {
  it("writes source.json with a dereferenced document", async () => {
    const ws = new Workspace(dir);
    const file = await ingest(ws, "petstore", [PETSTORE]);
    expect(file.endsWith(path.join("petstore", "source.json"))).toBe(true);
    const source = await ws.read("petstore", "source.json", SourceSchema);
    expect(source.inputs).toHaveLength(1);
    expect(source.inputs[0].kind).toBe("openapi");
    const doc = JSON.parse(source.inputs[0].content);
    // $ref가 해석되어 있어야 한다
    expect(doc.paths["/pets/{petId}"].get.responses["200"].content["application/json"].schema.properties.name.type).toBe("string");
  });

  it("expands recursive schemas and breaks only true cycles", async () => {
    const ws = new Workspace(dir);
    await ingest(ws, "circular", [CIRCULAR]);
    const source = await ws.read("circular", "source.json", SourceSchema);
    const doc = JSON.parse(source.inputs[0].content);
    const schema = doc.paths["/tree"].get.responses["200"].content["application/json"].schema;
    expect(schema.properties.root.properties.id).toEqual({ type: "integer" });
    expect(schema.properties.root.properties.children.items).toEqual({ "x-specmock-circular": true });
    expect(source.inputs[0].content).not.toContain('"$ref"');
  });

  it("rejects non-openapi inputs in this phase", async () => {
    const ws = new Workspace(dir);
    const md = path.join(dir, "doc.md");
    await writeFile(md, "# API\n", "utf8");
    await expect(ingest(ws, "x", [md])).rejects.toThrow(/Phase 1B/);
  });
});
