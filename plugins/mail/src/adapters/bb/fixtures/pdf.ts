// Minimal hand-written PDFs for tests, built at run time: one Helvetica
// text line per page, drawn inside the page box (pdf.js skips text outside
// the MediaBox). Made-up text only.

function escapePdf(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

function assemble(objects: string[], trailerExtra = ""): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function pageObjects(pages: string[]): string[] {
  // 1 catalog, 2 pages, 3 font, then a page and its content per page.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 20 100 Td (${escapePdf(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  return objects;
}

/** A PDF with one text line per page. */
export function buildPdf(pages: string[]): Uint8Array {
  return assemble(pageObjects(pages));
}

/** A PDF that names a standard security handler whose user password is not empty: pdf.js asks for a password. */
export function buildEncryptedPdf(text: string): Uint8Array {
  const objects = pageObjects([text]);
  const hex = (byte: string) => byte.repeat(32);
  objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${hex("1f")}> /U <${hex("2e")}> /P -4 >>`);
  const encrypt = objects.length;
  const id = "0123456789abcdef0123456789abcdef";
  return assemble(objects, ` /Encrypt ${encrypt} 0 R /ID [<${id}> <${id}>]`);
}
