import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { env } from '../config/env';
import { readWorkbook } from './xlsx-read';
import { readDeckText } from './pptx-read';

/** Cap how much raw text we keep and send to the AI provider. */
const MAX_CHARS = 20_000;

export interface TextExtractionResult {
  text: string | null;
  /** Set when the format is recognised but not something we can read text from yet. */
  unsupportedFormat: boolean;
}

/**
 * Reads plain text out of an uploaded reference file.
 *
 * Every OOXML format is read here (.docx, .xlsx, .pptx) alongside .txt and .pdf, because the
 * planning analysis reads *documents* — a project's scope often arrives as a spreadsheet and its
 * milestones as a deck, and accepting those uploads while silently seeing nothing in them would be
 * worse than refusing them.
 *
 * Still not parsed: the pre-2007 binary formats (.doc, .xls, .ppt), which are a different container
 * entirely, and a PDF that is a scan — it has no text layer to find, in any language. Both are
 * stored, flagged, and the PM is asked for a readable copy.
 */
export async function extractTextFromFile(params: {
  storageKey: string;
  fileName: string;
}): Promise<TextExtractionResult> {
  const ext = path.extname(params.fileName).toLowerCase();
  const filePath = path.join(env.uploadDir, params.storageKey);

  try {
    if (ext === '.txt') {
      const raw = await fs.readFile(filePath, 'utf-8');
      return { text: normalize(raw), unsupportedFormat: false };
    }

    if (ext === '.docx') {
      const buffer = await fs.readFile(filePath);
      const { value } = await mammoth.extractRawText({ buffer });
      return { text: normalize(value), unsupportedFormat: false };
    }

    if (ext === '.pdf') {
      const buffer = await fs.readFile(filePath);
      const { text } = await pdfParse(buffer);
      return { text: normalize(text), unsupportedFormat: false };
    }

    if (ext === '.xlsx' || ext === '.xlsm') {
      const buffer = await fs.readFile(filePath);
      return { text: normalize(await readWorkbookText(buffer)), unsupportedFormat: false };
    }

    if (ext === '.pptx') {
      const buffer = await fs.readFile(filePath);
      return { text: normalize(await readDeckTextFlat(buffer)), unsupportedFormat: false };
    }

    return { text: null, unsupportedFormat: true };
  } catch (error) {
    console.error('[extract-text] failed to read', params.fileName, error);
    return { text: null, unsupportedFormat: false };
  }
}

/**
 * A workbook as readable lines: `Sheet — a | b | c`, one row per line.
 *
 * Reads the sheets rather than the shared-strings table so the layout survives — which column a
 * value sits under is most of what a spreadsheet means, and a flat list of every string in the file
 * loses exactly that. `readWorkbook` already skips hidden sheets and resolves merges.
 */
async function readWorkbookText(buffer: Buffer): Promise<string> {
  const sheets = await readWorkbook(buffer);
  return sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((row) => row.map((cell) => cell.trim()).filter(Boolean).join(' | '))
        .filter(Boolean);
      return rows.length ? `## ${sheet.name}\n${rows.join('\n')}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** A deck as readable lines, slide by slide — the same reader the deck preview used. */
async function readDeckTextFlat(buffer: Buffer): Promise<string> {
  const slides = await readDeckText(buffer);
  return slides
    .filter((slide) => slide.lines.length)
    .map((slide) => `## Slide ${slide.number}\n${slide.lines.join('\n')}`)
    .join('\n\n');
}

function normalize(raw: string): string | null {
  const cleaned = raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_CHARS ? cleaned.slice(0, MAX_CHARS) : cleaned;
}
