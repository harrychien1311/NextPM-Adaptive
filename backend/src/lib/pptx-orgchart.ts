/**
 * Draws the org chart as an actual chart — one slide of boxes, one column per organisation.
 *
 * The Organization Chart used to export as prose with a note apologising that it was not a
 * diagram. A reporting structure written as paragraphs is not a reporting structure; nobody reads
 * one in a kickoff. So this draws it, in the same left-to-right organisation columns the SKAX
 * kickoff deck uses, because that is the shape PMs in this domain already read.
 *
 * Everything is positioned absolutely, as in `pptx-build.ts` — there is no placeholder inheritance
 * to get wrong, and the layout is computed here so it is the same on every renderer.
 */

import JSZip from 'jszip';
import { DOC_COLORS, GAP_LABEL, splitOnGaps } from '../modules/documents/document-format';
import { fitLogo } from './pptx-build';
import type { OrgChart, OrgChartNode } from '../modules/ai/provider';

const SLIDE_W = 12_192_000;
const SLIDE_H = 6_858_000;
const MARGIN = 457_200; // 0.5"

const TITLE_H = 640_080;
const HEADER_H = 411_480; // the organisation name band at the top of a column
const GROUP_LABEL_H = 274_320;
const NODE_H = 594_360;
const NODE_GAP = 91_440;
const GROUP_GAP = 182_880;
const COLUMN_GAP = 274_320;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Run {
  text: string;
  size: number;
  bold?: boolean;
  color?: string;
  highlight?: boolean;
}

function runXml(run: Run): string {
  const props = [`sz="${run.size}"`, run.bold ? 'b="1"' : '', 'dirty="0"'].filter(Boolean).join(' ');
  const fill = run.highlight
    ? `<a:solidFill><a:srgbClr val="${DOC_COLORS.gapText}"/></a:solidFill>` +
      `<a:highlight><a:srgbClr val="${DOC_COLORS.gapBg}"/></a:highlight>`
    : `<a:solidFill><a:srgbClr val="${run.color ?? DOC_COLORS.navy}"/></a:solidFill>`;
  return (
    `<a:r><a:rPr lang="en-US" ${props}>${fill}<a:latin typeface="Calibri"/></a:rPr>` +
    `<a:t>${escapeXml(run.text)}</a:t></a:r>`
  );
}

/** A line of text, splitting `{{gap:N}}` into its own highlighted run. */
function lineXml(text: string, style: Omit<Run, 'text'>, align: 'ctr' | 'l' = 'ctr'): string {
  const runs = splitOnGaps(text)
    .map((part) => (part.gap ? runXml({ ...style, text: GAP_LABEL, highlight: true }) : runXml({ ...style, text: part.text })))
    .join('');
  return `<a:p><a:pPr algn="${align}"/>${runs}</a:p>`;
}

interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

function shape(
  id: number,
  name: string,
  box: Box,
  lines: string[],
  options: { fill?: string; line?: string; rounded?: boolean; dashed?: boolean } = {},
): string {
  const geom = options.rounded ? 'roundRect' : 'rect';
  const fill = options.fill ? `<a:solidFill><a:srgbClr val="${options.fill}"/></a:solidFill>` : '<a:noFill/>';
  const line = options.line
    ? `<a:ln w="12700"${options.dashed ? '' : ''}><a:solidFill><a:srgbClr val="${options.line}"/></a:solidFill>` +
      `${options.dashed ? '<a:prstDash val="dash"/>' : ''}</a:ln>`
    : '<a:ln><a:noFill/></a:ln>';

  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" anchor="ctr" lIns="45720" rIns="45720" tIns="27432" bIns="27432">` +
    `<a:normAutofit/></a:bodyPr><a:lstStyle/>${lines.join('') || '<a:p/>'}</p:txBody></p:sp>`
  );
}

/** A straight connector between two column headers, so the columns read as one engagement. */
function connector(id: number, from: Box, to: Box): string {
  const y = from.y + from.cy / 2;
  return (
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Link ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${from.x + from.cx}" y="${y}"/>` +
    `<a:ext cx="${to.x - (from.x + from.cx)}" cy="0"/></a:xfrm>` +
    `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="${DOC_COLORS.rule}"/></a:solidFill>` +
    `<a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>`
  );
}

function nodeLines(node: OrgChartNode, fontScale = 1): string[] {
  const size = Math.round(1000 * fontScale);
  return [
    lineXml(node.role, { size, bold: true, color: node.lead ? 'FFFFFF' : DOC_COLORS.navy }),
    lineXml(node.person, { size, color: node.lead ? 'FFFFFF' : DOC_COLORS.muted }),
  ];
}

/** The vertical metrics, shrunk to fit when a column is taller than the slide. */
interface Metrics {
  nodeH: number;
  nodeGap: number;
  groupGap: number;
  labelH: number;
  /** Text is scaled with the boxes, or it would overflow them once they shrink. */
  fontScale: number;
}

/**
 * Below this the boxes stop being readable. A chart that still overruns at this scale has more
 * roles than one slide can hold, and squeezing further would only make it illegible as well as
 * crowded — the honest answer there is fewer roles on the chart, which is the PM's call.
 */
const MIN_LAYOUT_SCALE = 0.55;

function scaledMetrics(scale: number): Metrics {
  return {
    nodeH: Math.round(NODE_H * scale),
    nodeGap: Math.round(NODE_GAP * scale),
    groupGap: Math.round(GROUP_GAP * scale),
    labelH: Math.round(GROUP_LABEL_H * scale),
    // Text shrinks more slowly than the boxes: a box at 70% height still holds 85%-size text.
    fontScale: Math.max(0.7, (1 + scale) / 2),
  };
}

/** How tall a column is, so every column can be drawn from a common top. */
function columnHeight(groups: OrgChart['columns'][number]['groups'], m: Metrics): number {
  return groups.reduce((total, group, index) => {
    const label = group.name ? m.labelH : 0;
    const nodes = group.nodes.length * m.nodeH + Math.max(0, group.nodes.length - 1) * m.nodeGap;
    return total + label + nodes + (index ? m.groupGap : 0);
  }, 0);
}

/** The customer's logo, drawn top-right — `buildDeck` embedded the media part as rId2. */
function logoXml(id: number, data: Buffer): string {
  const box = fitLogo(data, { x: SLIDE_W - MARGIN - 1_828_800, y: MARGIN, cx: 1_828_800, cy: 640_080 });
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Customer logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** The slide XML for the chart itself. */
export function orgChartSlideXml(
  chart: OrgChart,
  title: string,
  subtitle: string,
  logo: Buffer | null = null,
): string {
  const columns = chart.columns.filter((column) => column.groups.some((group) => group.nodes.length));
  const shapes: string[] = [];
  let id = 2;

  shapes.push(
    // Leave room on the right for the logo rather than letting the title run under it.
    shape(id++, 'Title', { x: MARGIN, y: MARGIN, cx: SLIDE_W - MARGIN * 2 - (logo ? 1_920_240 : 0), cy: TITLE_H }, [
      lineXml(title, { size: 2400, bold: true, color: DOC_COLORS.navy }, 'l'),
      lineXml(subtitle, { size: 1100, color: DOC_COLORS.muted }, 'l'),
    ]),
  );
  if (logo) shapes.push(logoXml(id++, logo));

  if (!columns.length) {
    shapes.push(
      shape(id++, 'Empty', { x: MARGIN, y: SLIDE_H / 2 - NODE_H, cx: SLIDE_W - MARGIN * 2, cy: NODE_H * 2 }, [
        lineXml('This chart has no structure yet.', { size: 1400, bold: true, color: DOC_COLORS.navy }),
        lineXml(
          'Press “Generate document” in the Planning Studio. A chart generated before this document ' +
            'became a drawn chart holds prose instead, and needs generating again.',
          { size: 1100, color: DOC_COLORS.muted },
        ),
      ]),
    );
    return wrapSlide(shapes);
  }

  const columnWidth = Math.floor(
    (SLIDE_W - MARGIN * 2 - COLUMN_GAP * (columns.length - 1)) / columns.length,
  );
  const top = MARGIN + TITLE_H + 228_600;
  const available = SLIDE_H - MARGIN - top - HEADER_H;

  /**
   * Shrink the whole chart until the tallest column fits on the slide.
   *
   * A real project org chart has far more roles than a hand-made example: the first live one had a
   * delivery column of four named functions that ran straight off the bottom edge. A chart the
   * reader cannot see the bottom of is not a chart, so the boxes give way before the slide does.
   */
  const natural = Math.max(...columns.map((column) => columnHeight(column.groups, scaledMetrics(1))));
  const m = scaledMetrics(natural > available ? Math.max(MIN_LAYOUT_SCALE, available / natural) : 1);

  const tallest = Math.max(...columns.map((column) => columnHeight(column.groups, m)));
  // Centre what is left over; a chart that still overruns starts at the top rather than above it.
  const contentTop = top + Math.max(0, Math.floor((available - tallest) / 2));

  const headerBoxes: Box[] = [];

  columns.forEach((column, columnIndex) => {
    const x = MARGIN + columnIndex * (columnWidth + COLUMN_GAP);
    const header: Box = { x, y: contentTop, cx: columnWidth, cy: HEADER_H };
    headerBoxes.push(header);

    shapes.push(
      shape(id++, `Org ${column.organisation}`, header, [
        lineXml(column.organisation, { size: Math.round(1200 * m.fontScale), bold: true, color: 'FFFFFF' }),
      ], { fill: DOC_COLORS.navy, rounded: true }),
    );

    let y = contentTop + HEADER_H + m.groupGap;
    for (const group of column.groups) {
      if (!group.nodes.length) continue;
      if (group.name) {
        shapes.push(
          shape(id++, `Team ${group.name}`, { x, y, cx: columnWidth, cy: m.labelH }, [
            lineXml(group.name, { size: Math.round(1000 * m.fontScale), bold: true, color: DOC_COLORS.blue }),
          ]),
        );
        y += m.labelH;
      }
      for (const node of group.nodes) {
        shapes.push(
          shape(id++, node.role, { x, y, cx: columnWidth, cy: m.nodeH }, nodeLines(node, m.fontScale), {
            fill: node.lead ? DOC_COLORS.blue : 'FFFFFF',
            line: node.lead ? DOC_COLORS.blue : DOC_COLORS.rule,
            rounded: true,
          }),
        );
        y += m.nodeH + m.nodeGap;
      }
      y += m.groupGap - m.nodeGap;
    }
  });

  // Link the organisation headers left to right — this is one engagement, not three org charts.
  for (let i = 0; i < headerBoxes.length - 1; i += 1) {
    shapes.push(connector(id++, headerBoxes[i], headerBoxes[i + 1]));
  }

  return wrapSlide(shapes);
}

function wrapSlide(shapes: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/**
 * A one-slide `.pptx` containing only the chart.
 *
 * Built by replacing the single slide of a deck produced by `buildDeck`, so the package scaffolding
 * (content types, master, layout, theme) has exactly one definition rather than two that could
 * drift apart.
 */
export async function buildOrgChartDeck(params: {
  chart: OrgChart;
  title: string;
  subtitle: string;
  scaffold: Buffer;
  /**
   * The customer's logo. Pass the same buffer that was given to `buildDeck` for the scaffold —
   * that call embedded the media part and the slide relationship, and this only draws it. Passing
   * one here without passing it there would produce a picture pointing at a relationship that
   * does not exist, which PowerPoint reports as a damaged file.
   */
  logo?: Buffer | null;
}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(params.scaffold);

  // Only draw it if the scaffold really carries the image relationship.
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string');
  const logo = params.logo && rels?.includes('rId2') ? params.logo : null;

  zip.file('ppt/slides/slide1.xml', orgChartSlideXml(params.chart, params.title, params.subtitle, logo));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
