import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { env } from '../config/env';

/** Cap how much raw text we keep and send to the AI provider. */
const MAX_CHARS = 20_000;

export interface TextExtractionResult {
  text: string | null;
  /** Set when the format is recognised but not something we can read text from yet. */
  unsupportedFormat: boolean;
}

/**
 * Reads plain text out of an uploaded reference file. Supports the formats a text layer
 * can be pulled from directly (.txt, .docx, .pdf); legacy binary formats (.doc, .ppt, .pptx,
 * .xls, .xlsx) are stored but not parsed — the PM is told to re-upload as PDF/DOCX/TXT.
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

    return { text: null, unsupportedFormat: true };
  } catch (error) {
    console.error('[extract-text] failed to read', params.fileName, error);
    return { text: null, unsupportedFormat: false };
  }
}

function normalize(raw: string): string | null {
  const cleaned = raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_CHARS ? cleaned.slice(0, MAX_CHARS) : cleaned;
}
