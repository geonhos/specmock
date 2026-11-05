import { PDFParse } from "pdf-parse";

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    // 페이지 경계를 헤딩처럼 남겨 청크 분할이 페이지 단위로도 끊을 수 있게 한다.
    return result.pages.map((p, i) => `## [page ${i + 1}]\n\n${p.text.trim()}`).join("\n\n") + "\n";
  } finally {
    await parser.destroy();
  }
}
