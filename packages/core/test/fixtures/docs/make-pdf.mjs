// node packages/core/test/fixtures/docs/make-pdf.mjs
// 외부 의존성 없이 텍스트 한 페이지짜리 PDF를 만든다(pdf-parse가 읽을 수 있는 최소 구조). 결과 pets.pdf는 커밋한다.
import { writeFileSync } from "node:fs";
const lines = ["Pets API", "GET /pets returns an array of pets.", "GET /pets/{petId} returns one pet.", "DELETE /pets/{petId} returns 204."];
const content = lines.map((l, i) => `BT /F1 12 Tf 40 ${780 - i * 18} Td (${l.replace(/[()\\]/g, (c) => "\\" + c)}) Tj ET`).join("\n");
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let out = "%PDF-1.4\n"; const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(out);
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL("./pets.pdf", import.meta.url), out, "latin1");
