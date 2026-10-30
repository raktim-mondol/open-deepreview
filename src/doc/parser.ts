import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { PdfPageTextLayer, PdfTextItem } from "./target_algorithms.ts";
import { validatePdfBuffer } from "./target_algorithms.ts";

export interface ParsedManuscriptPage {
  pageNumber: number; // 1-indexed
  text: string;
  lines: string[];
  pdfTextLayer?: PdfPageTextLayer;
}

export interface ParsedManuscript {
  filename: string;
  format: "pdf" | "text" | "markdown" | "latex";
  fullText: string;
  lines: string[];
  pages: ParsedManuscriptPage[];
  rawBytes: Uint8Array;
}

/**
 * Exact reconstruction of `Zsa` and `$sa` (`module_ZZg41c.js` lines 1307-1308):
 * Splits UTF-8 text into lines after stripping BOM and normalizing CRLF/CR.
 */
export function splitTextToLines(text: string): string[] {
  const clean = (text.startsWith("\ufeff") ? text.slice(1) : text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!clean) return [];
  const lines = clean.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Parses a PDF buffer using `pdfjs-dist` (mirroring `dta` in `module_ZZg41c.js` line 1314)
 * to extract per-page text streams, items with 6-element transform matrices, and page dimensions.
 */
export async function parsePdfBuffer(
  bytes: Uint8Array,
  filename = "manuscript.pdf"
): Promise<ParsedManuscript> {
  const validation = validatePdfBuffer(bytes);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid PDF document");
  }

  // Dynamically import pdfjs-dist legacy build for Node/Bun compatibility
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const pages: ParsedManuscriptPage[] = [];
  const allLines: string[] = [];

  try {
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();

      const items: PdfTextItem[] = [];
      const lineBuckets: Array<{ y: number; parts: Array<{ x: number; str: string }> }> = [];

      for (const rawItem of textContent.items as any[]) {
        if (typeof rawItem.str !== "string") continue;
        const transform = Array.isArray(rawItem.transform)
          ? rawItem.transform.map(Number)
          : [1, 0, 0, 1, 0, 0];
        const width = Number(rawItem.width ?? 0);
        items.push({
          str: rawItem.str,
          transform,
          width,
        });

        const x = transform[4] ?? 0;
        const y = transform[5] ?? 0;
        if (!rawItem.str.trim()) continue;

        const bucket = lineBuckets.find((b) => Math.abs(b.y - y) < 4);
        if (bucket) {
          bucket.parts.push({ x, str: rawItem.str });
        } else {
          lineBuckets.push({ y, parts: [{ x, str: rawItem.str }] });
        }
      }

      // Sort top-to-bottom (descending PDF y), then left-to-right (ascending PDF x)
      lineBuckets.sort((a, b) => b.y - a.y);
      const pageLines = lineBuckets.map((b) => {
        b.parts.sort((p1, p2) => p1.x - p2.x);
        return b.parts.map((p) => p.str).join(" ").replace(/\s+/g, " ").trim();
      });

      const pageText = pageLines.join("\n");
      allLines.push(`--- [Page ${pageNum}] ---`, ...pageLines);

      pages.push({
        pageNumber: pageNum,
        text: pageText,
        lines: pageLines,
        pdfTextLayer: {
          pageNumber: pageNum,
          width: viewport.width,
          height: viewport.height,
          items,
        },
      });
    }
  } finally {
    await pdfDoc.destroy?.();
  }

  return {
    filename,
    format: "pdf",
    fullText: pages.map((p) => `[Page ${p.pageNumber}]\n${p.text}`).join("\n\n"),
    lines: allLines,
    pages,
    rawBytes: bytes,
  };
}

/**
 * Parses any supported manuscript file (`.pdf`, `.tex`, `.md`, `.markdown`, `.txt`).
 */
export async function parseManuscriptFile(filePath: string): Promise<ParsedManuscript> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const filename = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // Check if PDF by extension or magic header `%PDF-`
  const isPdfMagic =
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;

  if (ext === ".pdf" || isPdfMagic) {
    return parsePdfBuffer(bytes, filename);
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = splitTextToLines(text);
  const format: ParsedManuscript["format"] =
    ext === ".tex"
      ? "latex"
      : ext === ".md" || ext === ".markdown"
      ? "markdown"
      : "text";

  // Group plain-text / LaTeX into synthetic 55-line pages for segmentation while preserving 1-indexed line numbers
  const linesPerPage = 55;
  const pages: ParsedManuscriptPage[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    const slice = lines.slice(i, i + linesPerPage);
    const pageNum = Math.floor(i / linesPerPage) + 1;
    pages.push({
      pageNumber: pageNum,
      text: slice
        .map((line, idx) => `[L${i + idx + 1}] ${line}`)
        .join("\n"),
      lines: slice,
    });
  }

  if (pages.length === 0) {
    pages.push({ pageNumber: 1, text: "", lines: [] });
  }

  return {
    filename,
    format,
    fullText: lines.map((l, idx) => `[L${idx + 1}] ${l}`).join("\n"),
    lines,
    pages,
    rawBytes: bytes,
  };
}
