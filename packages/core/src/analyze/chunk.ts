/**
 * Markdown 텍스트를 LLM 추출용 청크로 나눈다.
 *
 * - 헤딩(`#`..`######`) 줄 기준으로 섹션을 나누고, 섹션을 maxChars 이하가 되는 만큼 순서대로 합친다.
 * - 한 섹션이 maxChars를 넘으면 빈 줄 > 줄 끝 > 강제 순으로 자르고, 앞 조각의 꼬리 `overlap`자를 다음 조각 앞에 겹친다.
 * - 펜스 코드 블록(```/~~~) 안의 `#` 줄은 헤딩이 아니며, 피할 수 있으면 펜스 안에서 자르지 않는다.
 * - 입력만으로 결과가 결정된다(시간·난수 없음).
 */

export interface ChunkOptions {
  /** 청크 하나의 최대 글자 수. */
  maxChars: number;
  /** 긴 섹션을 강제로 자를 때 앞 조각 꼬리를 다음 조각에 겹치는 글자 수. maxChars/4 로 상한. */
  overlap: number;
}
export const DEFAULT_CHUNK: ChunkOptions = { maxChars: 6000, overlap: 200 };

export interface TextChunk {
  /** 청크가 속한 첫 헤딩 텍스트(`#` 제거). 헤딩 앞 내용만 있으면 "". */
  heading: string;
  text: string;
}

interface Section { heading: string; text: string }

// ---------------------------------------------------------------------------
// 펜스 추적: 여는 펜스는 3개 이상의 ` 또는 ~, 닫는 펜스는 같은 문자·같거나 더 긴 길이·뒤가 공백뿐.
// (CommonMark 규칙의 부분집합. 4-백틱 펜스가 3-백틱 펜스를 감싸도 어긋나지 않는다.)

interface Fence { char: string; len: number }
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function nextFenceState(line: string, open: Fence | null): Fence | null {
  const m = FENCE_RE.exec(line);
  if (!m) return open;
  const char = m[1][0];
  const len = m[1].length;
  if (!open) {
    // 백틱 펜스의 info string 에는 백틱이 올 수 없다(그 줄은 인라인 코드다).
    if (char === "`" && m[2].includes("`")) return null;
    return { char, len };
  }
  if (open.char === char && len >= open.len && m[2].trim() === "") return null;
  return open;
}

/** 텍스트 안의 펜스 블록 범위 [start, end) 를 글자 오프셋으로 돌려준다. 닫히지 않은 펜스는 끝까지다. */
function fenceRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let open: Fence | null = null;
  let openAt = 0;
  let pos = 0;
  for (const line of text.split("\n")) {
    const next = nextFenceState(line, open);
    if (!open && next) openAt = pos;
    else if (open && !next) ranges.push({ start: openAt, end: pos + line.length });
    open = next;
    pos += line.length + 1;
  }
  if (open) ranges.push({ start: openAt, end: text.length });
  return ranges;
}

// ---------------------------------------------------------------------------

const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** 헤딩 줄 기준으로 섹션을 나눈다. 첫 헤딩 앞의 내용은 heading "" 섹션이 된다. */
function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let heading = "";
  let buf: string[] = [];
  let fence: Fence | null = null;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length > 0) out.push({ heading, text });
    buf = [];
  };
  for (const line of markdown.split("\n")) {
    fence = nextFenceState(line, fence);
    const m = fence ? null : HEADING_RE.exec(line);
    if (m) {
      flush();
      heading = m[1];
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * 긴 텍스트를 max 이하 조각으로 자른다.
 * 자르는 지점은 빈 줄 > 줄 끝 > 강제 순이고, 펜스 블록 안에 떨어지면(피할 수 있을 때) 펜스 앞으로 당긴다.
 * 조각 끝의 공백은 잘라 내되 그 위치를 기준으로 다음 조각을 `overlap`자 앞에서 시작하므로
 * `parts[i+1]` 은 항상 `parts[i].slice(-overlap)` 으로 시작한다 — 단, 그 지점이 펜스 블록 안이면
 * 펜스가 끝난 직후(와 그 뒤 공백 다음)에서 시작한다.
 */
function hardSplit(text: string, max: number, overlap: number): string[] {
  const fences = fenceRanges(text);
  const fenceAround = (pos: number) => fences.find((r) => r.start < pos && pos < r.end);
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      let cut = window.lastIndexOf("\n\n");
      if (cut < max * 0.5) cut = window.lastIndexOf("\n");
      if (cut < max * 0.5) cut = max;
      end = start + cut;
      const fence = fenceAround(end);
      if (fence && fence.start - start > max * 0.3) end = fence.start;
      const trimmedEnd = start + text.slice(start, end).trimEnd().length;
      if (trimmedEnd > start) end = trimmedEnd;
    }
    parts.push(text.slice(start, end));
    if (end >= text.length) break;
    let next = Math.max(end - overlap, start + 1);
    const fence = fenceAround(next);
    if (fence && fence.end <= end) {
      next = fence.end;
      while (next < text.length && /\s/.test(text[next])) next++;
    }
    start = next;
  }
  return parts;
}

export function splitIntoChunks(markdown: string, opts: ChunkOptions = DEFAULT_CHUNK): TextChunk[] {
  const maxChars = Math.floor(opts.maxChars);
  if (!Number.isFinite(maxChars) || maxChars < 1) throw new RangeError(`maxChars must be >= 1 (got ${opts.maxChars})`);
  const overlap = Math.min(Math.max(0, Math.floor(opts.overlap) || 0), Math.floor(maxChars / 4));

  const secs = sections(markdown.replace(/\r\n?/g, "\n"));
  if (secs.length === 0) return [];
  const chunks: TextChunk[] = [];
  let cur: TextChunk | null = null;
  for (const s of secs) {
    if (s.text.length > maxChars) {
      if (cur) { chunks.push(cur); cur = null; }
      for (const piece of hardSplit(s.text, maxChars, overlap)) chunks.push({ heading: s.heading, text: piece });
      continue;
    }
    if (cur && cur.text.length + 2 + s.text.length <= maxChars) {
      cur.text += "\n\n" + s.text;
      // 헤딩 앞 내용(예: `<!-- source -->` 주석)만 있던 청크는 처음 합쳐지는 섹션의 헤딩을 쓴다.
      if (cur.heading === "") cur.heading = s.heading;
    } else {
      if (cur) chunks.push(cur);
      cur = { heading: s.heading, text: s.text };
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
