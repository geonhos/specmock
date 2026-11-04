import { readFile } from "node:fs/promises";
import { orderFeatures } from "../catalog/order.js";
import type { Catalog, Feature } from "../types.js";

type Matcher = (f: Feature, index: number) => boolean;
type Term = { kind: "include" | "filter"; negate: boolean; match: Matcher; raw: string };

function globToRegex(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function parseTerm(raw: string, catalog: Catalog, total: number): Term {
  let text = raw.trim();
  const negate = text.startsWith("-");
  if (negate) text = text.slice(1).trim();

  if (text === "all") return { kind: "include", negate, raw, match: () => true };

  const range = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (range) {
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    for (const n of [from, to]) if (n < 1 || n > total) throw new Error(`번호 ${n}은(는) 범위를 벗어납니다 (1-${total}).`);
    if (from > to) throw new Error(`범위 ${text}의 시작이 끝보다 큽니다.`);
    return { kind: "include", negate, raw, match: (_f, i) => i >= from && i <= to };
  }

  const method = /^method:([A-Za-z]+)$/.exec(text);
  if (method) {
    const m = method[1].toUpperCase();
    return { kind: "filter", negate, raw, match: (f) => f.method === m };
  }

  const group = /^group:(.+)$/.exec(text);
  if (group) {
    const g = group[1];
    return { kind: "filter", negate, raw, match: (f) => f.group === g };
  }

  const has = /^has:(example|schema)$/.exec(text);
  if (has) {
    return {
      kind: "filter", negate, raw,
      match: has[1] === "example"
        ? (f) => f.hasExample
        : (f) => Object.values(f.responses).some((r) => r.schema !== null),
    };
  }

  const conf = /^confidence(>=|<=|>|<|=)(\d(?:\.\d+)?)$/.exec(text);
  if (conf) {
    const op = conf[1];
    const v = Number(conf[2]);
    const cmp: Record<string, (a: number) => boolean> = {
      ">=": (a) => a >= v, "<=": (a) => a <= v, ">": (a) => a > v, "<": (a) => a < v, "=": (a) => a === v,
    };
    return { kind: "filter", negate, raw, match: (f) => cmp[op](f.confidence) };
  }

  if (text.includes("*")) {
    const re = globToRegex(text);
    if (!negate && !catalog.features.some((f) => re.test(f.id))) throw new Error(`일치하는 기능이 없는 글롭: ${text}`);
    return { kind: "include", negate, raw, match: (f) => re.test(f.id) };
  }

  if (/^[A-Za-z0-9_.-]+$/.test(text)) {
    if (!catalog.features.some((f) => f.id === text)) throw new Error(`알 수 없는 기능 id: ${text}`);
    return { kind: "include", negate, raw, match: (f) => f.id === text };
  }

  throw new Error(`해석할 수 없는 선택 항목: '${raw}'`);
}

async function expandFiles(exprs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const expr of exprs) {
    for (const item of expr.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (item.startsWith("@")) {
        const file = item.slice(1);
        let json: { selected?: unknown };
        try {
          json = JSON.parse(await readFile(file, "utf8")) as { selected?: unknown };
        } catch (e) {
          throw new Error(`${file}: 선택 파일을 읽을 수 없습니다. ${(e as Error).message}`);
        }
        if (!Array.isArray(json.selected)) throw new Error(`${file}에 selected 배열이 없습니다.`);
        for (const s of json.selected as unknown[]) {
          if (typeof s !== "string") throw new Error(`${file}의 selected 항목은 문자열이어야 합니다.`);
          for (const sub of s.split(",").map((t) => t.trim()).filter(Boolean)) {
            if (sub.startsWith("@")) throw new Error("@파일 안에서 @파일을 또 참조할 수 없습니다.");
            out.push(sub);
          }
        }
      } else {
        out.push(item);
      }
    }
  }
  return out;
}

/** 표현식을 해석하여 표시 순서대로 정렬된 feature id 배열을 돌려준다. */
export async function resolveSelection(catalog: Catalog, exprs: string[]): Promise<string[]> {
  const ordered = orderFeatures(catalog);
  const items = await expandFiles(exprs);
  if (items.length === 0) throw new Error("선택 항목이 비어 있습니다. 예: all, users.*, 1-5");

  const selected = new Set<string>();
  for (const item of items) {
    const term = parseTerm(item, catalog, ordered.length);
    const matching = ordered.filter(({ feature, index }) => term.match(feature, index)).map((o) => o.feature.id);
    if (term.negate) {
      for (const id of matching) selected.delete(id);
    } else if (term.kind === "include" || selected.size === 0) {
      for (const id of matching) selected.add(id);
    } else {
      const keep = new Set(matching);
      for (const id of [...selected]) if (!keep.has(id)) selected.delete(id);
    }
  }
  return ordered.map((o) => o.feature.id).filter((id) => selected.has(id));
}
