/**
 * Builds a real `.pptx` from scratch, for a customer who has no template of their own.
 *
 * Why this exists rather than reusing another customer's deck: the SKAX kickoff template is not
 * only branded, it is *written about SKAX* — slide 11 is a page of R&R prose naming what SKAX
 * provides, and slides 10 and 13 name them repeatedly. Search-and-replacing the customer name
 * there would produce a document asserting things about a company nobody checked, which is exactly
 * the fabrication the rest of this system refuses to do. So a customer without their own template
 * gets a neutral deck carrying **their** logo and this project's own content — never someone
 * else's deck with the name swapped.
 *
 * A `.pptx` is a zip of XML parts. This writes the minimum set PowerPoint needs — content types,
 * a theme, one master, one blank layout, and the slides — with everything positioned absolutely,
 * so there is no placeholder inheritance to get wrong. Colours mirror `document-format.ts`, so a
 * deck and a Word document from the same project look like the same project.
 */

import JSZip from 'jszip';
import { DOC_COLORS, GAP_LABEL, splitOnGaps } from '../modules/documents/document-format';

/** 16:9 at PowerPoint's default size, in EMU (914400 EMU = 1 inch). */
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MARGIN = 685800; // 0.75"

export interface DeckSlide {
  title: string;
  /** One bullet per line. May contain `{{gap:N}}`, which renders as a visible blank. */
  bullets: string[];
}

export interface DeckSpec {
  projectName: string;
  documentName: string;
  customerName: string | null;
  /** Shown under the title — version and status, so a draft is never mistaken for a baseline. */
  subtitle: string;
  slides: DeckSlide[];
  /** The customer's logo, placed on the title slide. */
  logo?: { data: Buffer; extension: string; mimeType: string } | null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface RunStyle {
  size: number; // hundredths of a point
  bold?: boolean;
  color?: string;
  italic?: boolean;
}

function run(text: string, style: RunStyle, highlight = false): string {
  const props = [
    `sz="${style.size}"`,
    style.bold || highlight ? 'b="1"' : '',
    style.italic ? 'i="1"' : '',
    'dirty="0"',
  ]
    .filter(Boolean)
    .join(' ');

  const color = highlight ? DOC_COLORS.gapText : style.color ?? DOC_COLORS.navy;
  const fill = highlight
    ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
      `<a:highlight><a:srgbClr val="${DOC_COLORS.gapBg}"/></a:highlight>`
    : `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;

  return (
    `<a:r><a:rPr lang="en-US" ${props}>${fill}<a:latin typeface="Calibri"/></a:rPr>` +
    `<a:t>${escapeXml(text)}</a:t></a:r>`
  );
}

/**
 * One paragraph, split into runs so an unanswered blank is *visibly* a blank — amber on a pale
 * highlight, the same as in the Word and Excel exports. A raw `{{gap:3}}` must never reach a slide,
 * and neither must a blank that reads like ordinary text.
 */
function paragraph(text: string, style: RunStyle, bullet = false): string {
  // `marL`/`indent` plus a buChar is what actually draws a bullet; without them the text is flush.
  const paraProps = bullet
    ? `<a:pPr marL="228600" indent="-228600"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc>` +
      `<a:spcBef><a:spcPts val="600"/></a:spcBef><a:buChar char="•"/></a:pPr>`
    : '<a:pPr><a:lnSpc><a:spcPct val="100000"/></a:lnSpc></a:pPr>';

  const runs = splitOnGaps(text)
    .map((part) => (part.gap ? run(GAP_LABEL, style, true) : run(part.text, style)))
    .join('');

  return `<a:p>${paraProps}${runs}</a:p>`;
}

/**
 * Pixel size of a PNG, JPEG or GIF, read from its header.
 *
 * Needed because a logo dropped into a fixed box is *stretched* to fill it, which distorts the
 * customer's mark — the one thing on the deck that must look right. Returns null for anything
 * unreadable (SVG has no fixed pixel size), and the caller then centres it in the box unscaled.
 */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  // PNG: IHDR width/height at bytes 16-23.
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // GIF: little-endian width/height at bytes 6-9.
  if (data.length > 10 && data.subarray(0, 3).toString('ascii') === 'GIF') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  // JPEG: walk the segment chain to the first SOF marker, which carries the dimensions.
  if (data.length > 4 && data.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      // SOF0-SOF15, excluding the non-frame markers DHT (c4), JPGA (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Largest size an image can take inside `maxWidth` × `maxHeight` without distorting it.
 * Falls back to the box itself when the dimensions cannot be read (an SVG, say).
 */
export function fitWithin(data: Buffer, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const size = imageSize(data);
  if (!size?.width || !size.height) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

/** Fits an image inside a box without distorting it, centred on the box's right edge. */
export function fitLogo(data: Buffer, box: { x: number; y: number; cx: number; cy: number }) {
  const size = imageSize(data);
  if (!size || !size.width || !size.height) return box;

  const scale = Math.min(box.cx / size.width, box.cy / size.height);
  const cx = Math.round(size.width * scale);
  const cy = Math.round(size.height * scale);
  return {
    x: box.x + (box.cx - cx), // right-aligned in the band
    y: box.y + Math.round((box.cy - cy) / 2),
    cx,
    cy,
  };
}

function textBox(
  id: number,
  name: string,
  box: { x: number; y: number; cx: number; cy: number },
  paragraphs: string[],
  anchor: 't' | 'ctr' = 't',
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
    `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    `${paragraphs.join('')}</p:txBody></p:sp>`
  );
}

function filledRect(id: number, box: { x: number; y: number; cx: number; cy: number }, color: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Band ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

function picture(id: number, relId: string, box: { x: number; y: number; cx: number; cy: number }): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Customer logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

const SLIDE_OPEN =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const SLIDE_CLOSE = '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

function titleSlideXml(spec: DeckSpec, logoData: Buffer | null): string {
  const shapes: string[] = [
    filledRect(2, { x: 0, y: 0, cx: SLIDE_W, cy: 1600200 }, DOC_COLORS.navy),
    textBox(
      3,
      'Title',
      { x: MARGIN, y: 2286000, cx: SLIDE_W - MARGIN * 2, cy: 1600200 },
      [
        paragraph(spec.projectName, { size: 4000, bold: true, color: DOC_COLORS.navy }),
        paragraph(spec.documentName, { size: 2000, color: DOC_COLORS.blue }),
      ],
    ),
    textBox(
      4,
      'Subtitle',
      { x: MARGIN, y: 4114800, cx: SLIDE_W - MARGIN * 2, cy: 914400 },
      [
        paragraph(spec.subtitle, { size: 1400, color: DOC_COLORS.muted }),
        paragraph(
          'AI-drafted from PM-verified project inputs. Highlighted blanks are facts the project data did not contain.',
          { size: 1100, italic: true, color: DOC_COLORS.muted },
        ),
      ],
    ),
  ];

  if (spec.customerName) {
    shapes.push(
      textBox(
        5,
        'Customer',
        { x: MARGIN, y: 533400, cx: SLIDE_W - MARGIN * 2 - 2286000, cy: 685800 },
        [paragraph(spec.customerName, { size: 1600, bold: true, color: 'FFFFFF' })],
        'ctr',
      ),
    );
  }
  if (logoData) {
    // Top-right of the navy band, the conventional place for a customer mark, scaled to fit
    // rather than stretched — a distorted logo is worse than no logo.
    shapes.push(
      picture(6, 'rId2', fitLogo(logoData, { x: SLIDE_W - MARGIN - 1828800, y: 411480, cx: 1828800, cy: 777240 })),
    );
  }

  return SLIDE_OPEN + shapes.join('') + SLIDE_CLOSE;
}

/** Small logo in the slide footer. Half the title-slide size — a mark, not a banner. */
const FOOTER_LOGO_BOX = { x: SLIDE_W - MARGIN - 914_400, y: SLIDE_H - 594_360, cx: 914_400, cy: 365_760 };

function contentSlideXml(slide: DeckSlide, index: number, total: number, logoData: Buffer | null): string {
  const shapes = [
    filledRect(2, { x: 0, y: 0, cx: SLIDE_W, cy: 45720 }, DOC_COLORS.blue),
    textBox(
      3,
      'Title',
      { x: MARGIN, y: 457200, cx: SLIDE_W - MARGIN * 2, cy: 914400 },
      [paragraph(slide.title, { size: 2400, bold: true, color: DOC_COLORS.navy })],
    ),
    filledRect(4, { x: MARGIN, y: 1371600, cx: SLIDE_W - MARGIN * 2, cy: 22860 }, DOC_COLORS.rule),
    textBox(
      5,
      'Body',
      { x: MARGIN, y: 1600200, cx: SLIDE_W - MARGIN * 2, cy: SLIDE_H - 1600200 - 685800 },
      slide.bullets.length
        ? slide.bullets.map((bullet) => paragraph(bullet, { size: 1400 }, true))
        : [paragraph('—', { size: 1400, color: DOC_COLORS.muted })],
    ),
    textBox(
      6,
      'Footer',
      { x: MARGIN, y: SLIDE_H - 548640, cx: SLIDE_W - MARGIN * 2, cy: 365760 },
      [paragraph(`${index} / ${total}`, { size: 1000, color: DOC_COLORS.muted })],
    ),
    // The customer's mark on every slide, not only the title — a deck gets read one slide at a
    // time, and slides get pulled out of it into other decks.
    ...(logoData ? [picture(7, 'rId2', fitLogo(logoData, FOOTER_LOGO_BOX))] : []),
  ];
  return SLIDE_OPEN + shapes.join('') + SLIDE_CLOSE;
}

// ---------------------------------------------------------------------------
// The fixed scaffolding every .pptx needs
// ---------------------------------------------------------------------------

const THEME_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="NEXTPLAN AI">' +
  '<a:themeElements><a:clrScheme name="NEXTPLAN AI">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  `<a:dk2><a:srgbClr val="${DOC_COLORS.navy}"/></a:dk2>` +
  '<a:lt2><a:srgbClr val="F4F7FB"/></a:lt2>' +
  `<a:accent1><a:srgbClr val="${DOC_COLORS.blue}"/></a:accent1>` +
  `<a:accent2><a:srgbClr val="${DOC_COLORS.navy}"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="${DOC_COLORS.rule}"/></a:accent3>` +
  `<a:accent4><a:srgbClr val="${DOC_COLORS.muted}"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="${DOC_COLORS.gapText}"/></a:accent5>` +
  `<a:accent6><a:srgbClr val="${DOC_COLORS.zebra}"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="${DOC_COLORS.blue}"/></a:hlink>` +
  `<a:folHlink><a:srgbClr val="${DOC_COLORS.muted}"/></a:folHlink>` +
  '</a:clrScheme>' +
  '<a:fontScheme name="NEXTPLAN AI">' +
  '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="NEXTPLAN AI">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';

const SLIDE_LAYOUT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="Blank"><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const SLIDE_MASTER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' +
  '<a:effectLst/></p:bgPr></p:bg><p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '</p:sldMaster>';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export async function buildDeck(spec: DeckSpec): Promise<Buffer> {
  const zip = new JSZip();
  const logoExt = spec.logo ? spec.logo.extension.replace('.', '').toLowerCase() : null;
  // Only image types PowerPoint can actually draw; anything else is skipped rather than embedded
  // as a part the renderer would reject.
  const logoOk = Boolean(spec.logo && logoExt && IMAGE_TYPES[logoExt]);

  const logoData = logoOk && spec.logo ? spec.logo.data : null;
  const slides = [
    titleSlideXml(spec, logoData),
    ...spec.slides.map((slide, index) => contentSlideXml(slide, index + 2, spec.slides.length + 1, logoData)),
  ];

  // ---- [Content_Types]
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...(logoOk ? [`<Default Extension="${logoExt}" ContentType="${IMAGE_TYPES[logoExt!]}"/>`] : []),
  ];
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ...slides.map(
      (_slide, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
  ];
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${overrides.join('')}</Types>`,
  );

  // ---- package rels
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
  );

  // ---- presentation
  const slideIds = slides
    .map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join('');
  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>` +
      '</p:presentation>',
  );

  const presentationRels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
    ...slides.map(
      (_slide, index) =>
        `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
    ),
    `<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
  ];
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels.join('')}</Relationships>`,
  );

  // ---- master, layout, theme
  zip.file('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER_XML);
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
      '</Relationships>',
  );
  zip.file('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT_XML);
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>',
  );
  zip.file('ppt/theme/theme1.xml', THEME_XML);

  // ---- slides
  slides.forEach((xml, index) => {
    const number = index + 1;
    zip.file(`ppt/slides/slide${number}.xml`, xml);
    const rels = [
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
      // Every slide, not just the title one: the logo now sits in each content slide's footer, and
      // a `<p:pic>` whose relationship is missing from *its own* slide is a damaged file.
      ...(logoOk
        ? [
            `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.${logoExt}"/>`,
          ]
        : []),
    ];
    zip.file(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
    );
  });

  if (logoOk && spec.logo) zip.file(`ppt/media/logo.${logoExt}`, spec.logo.data);

  // ---- document properties
  zip.file(
    'docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${escapeXml(`${spec.projectName} — ${spec.documentName}`)}</dc:title>` +
      '<dc:creator>NEXTPLAN AI</dc:creator>' +
      '<cp:lastModifiedBy>NEXTPLAN AI</cp:lastModifiedBy>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>` +
      '</cp:coreProperties>',
  );
  zip.file(
    'docProps/app.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>NEXTPLAN AI</Application>' +
      `<Slides>${slides.length}</Slides>` +
      '</Properties>',
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
