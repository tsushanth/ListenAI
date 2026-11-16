import AdmZip from 'adm-zip';
import { JSDOM } from 'jsdom';
import Anthropic from '@anthropic-ai/sdk';
import { instrumentAnthropic, withFeature } from './llm.js';
import { logger } from './logger.js';
import { config } from './config.js';

// ============================================================================
// Chapter Detection
// ============================================================================
// Splits long-form input into chapters for the Audiobooks MVP:
//  - ePub: parse the OPF spine + TOC (nav.xhtml / NCX) for real chapter
//    boundaries and titles, then extract plain text per spine item.
//  - Plain/PDF-extracted text (no structural markup to rely on): ask Claude
//    to propose chapter boundaries, following the same pattern as
//    `cleanContentWithLLM` in routes/extract.ts (system prompt + structured
//    JSON output).

const chapterLogger = logger.child({ module: 'chapter-detection' });

export interface DetectedChapter {
  title: string;
  text: string;
}

// Reuse the same Anthropic client construction pattern as routes/extract.ts.
const anthropic = config.ANTHROPIC_API_KEY
  ? instrumentAnthropic(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }))
  : null;
const LLM_MODEL = 'claude-sonnet-4-6';

// Safety bounds for LLM-based splitting.
const LLM_SPLIT_MAX_INPUT_CHARS = 100_000; // per LLM call
const LLM_SPLIT_MAX_CHAPTERS = 60;
const MIN_CHAPTER_CHARS = 200; // below this, folded into the previous/next chapter

// ============================================================================
// ePub chapter detection
// ============================================================================

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

/**
 * Parse an ePub (as a Buffer) into an ordered list of chapters using its
 * OPF manifest/spine and TOC (EPUB3 nav.xhtml, falling back to EPUB2 NCX).
 * Falls back to one chapter per spine item (titled generically) if no TOC
 * can be parsed, so a malformed/EPUB2-only book still produces something
 * usable rather than failing outright.
 */
export function detectChaptersFromEpub(epubBuffer: Buffer): DetectedChapter[] {
  const zip = new AdmZip(epubBuffer);

  const containerXml = readZipEntryText(zip, 'META-INF/container.xml');
  if (!containerXml) {
    throw new Error('Invalid ePub: missing META-INF/container.xml');
  }

  const opfPath = extractOpfPath(containerXml);
  if (!opfPath) {
    throw new Error('Invalid ePub: could not locate OPF (content.opf) path');
  }

  const opfXml = readZipEntryText(zip, opfPath);
  if (!opfXml) {
    throw new Error(`Invalid ePub: OPF file not found at ${opfPath}`);
  }

  const opfDir = dirname(opfPath);
  const { manifest, spineIds, navHref, ncxHref } = parseOpf(opfXml);

  // Map manifest id -> full zip path (resolved relative to the OPF directory)
  const idToPath = new Map<string, ManifestItem & { fullPath: string }>();
  for (const item of manifest) {
    idToPath.set(item.id, { ...item, fullPath: joinZipPath(opfDir, item.href) });
  }

  // Try to build a title lookup keyed by spine-item href, from the TOC.
  let titleByHref: Map<string, string> | null = null;
  if (navHref) {
    const navPath = joinZipPath(opfDir, navHref);
    const navXml = readZipEntryText(zip, navPath);
    if (navXml) titleByHref = parseNavToc(navXml, navPath);
  }
  if (!titleByHref && ncxHref) {
    const ncxPath = joinZipPath(opfDir, ncxHref);
    const ncxXml = readZipEntryText(zip, ncxPath);
    if (ncxXml) titleByHref = parseNcxToc(ncxXml, ncxPath);
  }

  // Preferred path: split the spine text at the TOC anchors and keep only the
  // real chapters (see detectChaptersByTocAnchors). Falls through to the
  // per-spine-item path below when the book has no usable TOC or nothing
  // qualifies (e.g. very short books).
  const tocEntries = readTocEntries(zip, opfDir, navHref, ncxHref);
  if (tocEntries.length > 0) {
    const spinePaths: string[] = [];
    for (const spineId of spineIds) {
      const item = idToPath.get(spineId);
      if (!item) continue;
      if (!/x?html?$/i.test(item.mediaType) && !/\.x?html?$/i.test(item.fullPath)) continue;
      spinePaths.push(item.fullPath);
    }
    const byToc = detectChaptersByTocAnchors(zip, spinePaths, tocEntries);
    if (byToc.length > 0) return byToc;
  }

  const chapters: DetectedChapter[] = [];

  for (const spineId of spineIds) {
    const item = idToPath.get(spineId);
    if (!item) continue;
    if (!/x?html?$/i.test(item.mediaType) && !/\.x?html?$/i.test(item.fullPath)) continue;

    const html = readZipEntryText(zip, item.fullPath);
    if (!html) continue;

    const text = htmlToPlainText(html);
    if (!text || text.trim().length === 0) continue;

    const title =
      (titleByHref && (titleByHref.get(item.fullPath) ?? titleByHref.get(stripFragment(item.fullPath)))) ||
      `Chapter ${chapters.length + 1}`;

    chapters.push({ title, text: text.trim() });
  }

  if (chapters.length === 0) {
    throw new Error('Invalid ePub: no readable chapter content found in spine');
  }

  return mergeShortChapters(chapters);
}

function readZipEntryText(zip: AdmZip, path: string): string | null {
  // ePub zip paths are stored without a leading slash; normalize.
  const normalized = path.replace(/^\/+/, '');
  const entry = zip.getEntry(normalized) ?? zip.getEntry(decodeURIComponent(normalized));
  if (!entry) return null;
  try {
    return zip.readAsText(entry, 'utf8');
  } catch (error) {
    chapterLogger.warn({ error, path }, 'Failed to read ePub zip entry');
    return null;
  }
}

function extractOpfPath(containerXml: string): string | null {
  const match = containerXml.match(/full-path=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function joinZipPath(dir: string, href: string): string {
  const cleanHref = href.replace(/^\.\//, '');
  if (!dir) return cleanHref;
  // Resolve simple '../' segments relative to dir.
  const parts = `${dir}/${cleanHref}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

function stripFragment(path: string): string {
  return path.split('#')[0] ?? path;
}

interface ParsedOpf {
  manifest: ManifestItem[];
  spineIds: string[];
  navHref: string | null; // EPUB3 nav document (properties="nav")
  ncxHref: string | null; // EPUB2 NCX (toc attribute on <spine>, resolved via manifest)
}

function parseOpf(opfXml: string): ParsedOpf {
  const dom = new JSDOM(opfXml, { contentType: 'application/xml' });
  const doc = dom.window.document;

  const manifest: ManifestItem[] = [];
  let navHref: string | null = null;
  let ncxId: string | null = null;

  doc.querySelectorAll('manifest item, item').forEach((el) => {
    const id = el.getAttribute('id');
    const href = el.getAttribute('href');
    const mediaType = el.getAttribute('media-type') ?? '';
    if (!id || !href) return;
    manifest.push({ id, href, mediaType });

    const properties = el.getAttribute('properties') ?? '';
    if (/\bnav\b/.test(properties)) navHref = href;
    if (mediaType === 'application/x-dtbncx+xml') ncxId = id;
  });

  const spineIds: string[] = [];
  let tocAttr: string | null = null;
  const spineEl = doc.querySelector('spine');
  if (spineEl) {
    tocAttr = spineEl.getAttribute('toc');
    spineEl.querySelectorAll('itemref').forEach((el) => {
      const idref = el.getAttribute('idref');
      if (idref) spineIds.push(idref);
    });
  }

  const ncxHref = tocAttr
    ? manifest.find((m) => m.id === tocAttr)?.href ?? null
    : ncxId
      ? manifest.find((m) => m.id === ncxId)?.href ?? null
      : null;

  return { manifest, spineIds, navHref, ncxHref };
}

/** EPUB3 nav.xhtml: <nav epub:type="toc"><ol><li><a href="ch01.xhtml#top">Chapter 1</a></li>...</nav> */
function parseNavToc(navXml: string, navPath: string): Map<string, string> {
  const dom = new JSDOM(navXml);
  const doc = dom.window.document;
  const result = new Map<string, string>();

  const navEl =
    Array.from(doc.querySelectorAll('nav')).find((n) => (n.getAttribute('epub:type') ?? '').includes('toc')) ??
    doc.querySelector('nav');

  const anchors = navEl ? navEl.querySelectorAll('a') : doc.querySelectorAll('a');
  anchors.forEach((a) => {
    const href = a.getAttribute('href');
    const title = a.textContent?.trim();
    if (!href || !title) return;
    const fullPath = joinZipPath(dirname(navPath), href);
    result.set(fullPath, title);
    result.set(stripFragment(fullPath), title);
  });

  return result;
}

/** EPUB2 NCX: <navMap><navPoint><navLabel><text>Chapter 1</text></navLabel><content src="ch01.html"/></navPoint></navMap> */
function parseNcxToc(ncxXml: string, ncxPath: string): Map<string, string> {
  const dom = new JSDOM(ncxXml, { contentType: 'application/xml' });
  const doc = dom.window.document;
  const result = new Map<string, string>();

  doc.querySelectorAll('navPoint').forEach((navPoint) => {
    const title = navPoint.querySelector('navLabel text')?.textContent?.trim();
    const src = navPoint.querySelector('content')?.getAttribute('src');
    if (!title || !src) return;
    const fullPath = joinZipPath(dirname(ncxPath), src);
    result.set(fullPath, title);
    result.set(stripFragment(fullPath), title);
  });

  return result;
}

// ----------------------------------------------------------------------------
// TOC-anchor chapter splitting
// ----------------------------------------------------------------------------
// The spine-item path above treats every spine document as a chapter. That
// over-splits books whose spine has front matter, licence pages, part
// dividers or per-section files, and it cannot split a book that keeps all
// chapters in a single XHTML file. This path instead:
//  1. flattens the TOC (nav.xhtml or NCX) in order, resolving each entry to a
//     character offset in the concatenated spine text (document offset +
//     offset of the #fragment anchor),
//  2. takes an entry's segment as the text up to the next TOC entry,
//  3. keeps numbered chapters (plus long unnumbered sections between the
//     first and last numbered one, and audible front/back sections such as a
//     prologue or epilogue) and drops front matter, licence text and short
//     part dividers.

const TOC_MIN_SEGMENT_CHARS = 1500;
const TOC_FRONT_MATTER_RE =
  /^\W*(table of )?contents|^\W*the full project gutenberg|^\W*project gutenberg|^\W*licen[cs]e|^\W*copyright|^\W*colophon|^\W*title page|^\W*cover\b|^\W*acknowledg|^\W*transcriber|^\W*(note to the )?(first|second|third|fourth|new|this) edition|^\W*illustrations?\b|^\W*list of (illustrations|characters)/i;
const TOC_AUDIBLE_SECTION_RE = /^\W*(epilogue|preface|prologue|introduction|foreword|afterword|conclusion)\b/i;
const TOC_PART_RE = /^\W*(part|book|volume|vol\.)\b/i;
// "Chapter 7", "Chapter XII", a leading roman numeral ("XII. The Storm") or a
// leading number ("7. The Storm"). The roman numeral must be a well-formed one
// so that ordinary words made of numeral letters ("Civil", "Mix") do not count.
const TOC_CHAPTER_NUMBER_RES = [
  /chapter\s*([ivxlc]+|\d+)\b/i,
  /^\s*(?=[ivxlc])(c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})\.?(\s|$)/i,
  /^\s*\d+\.?\s/,
];

interface TocEntry {
  title: string;
  /** Zip path of the target document, without the fragment. */
  path: string;
  fragment: string;
  /** False for an entry that has nested entries under it (a part/section heading). */
  leaf: boolean;
}

interface SpineTextDoc {
  /** Whitespace-collapsed text, used for offsets and length thresholds. */
  norm: string;
  /** Original text (CRLF normalised), kept so chapter text keeps its line breaks. */
  raw: string;
  /** Anchor id/name -> offset in `norm` and in `raw`. */
  anchors: Map<string, { n: number; r: number }>;
  offN: number;
  offR: number;
}

interface TocSegment {
  title: string;
  href: string;
  startN: number;
  endN: number;
  startR: number;
  endR: number;
  len: number;
  numbered: boolean;
  leaf: boolean;
}

function tocTitle(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

function splitHref(href: string, baseDir: string): { path: string; fragment: string } | null {
  const hashAt = href.indexOf('#');
  const file = hashAt === -1 ? href : href.slice(0, hashAt);
  let fragment = hashAt === -1 ? '' : href.slice(hashAt + 1);
  if (!file) return null;
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // keep the raw fragment
  }
  return { path: joinZipPath(baseDir, file), fragment };
}

function parseNavEntries(navXml: string, navPath: string): TocEntry[] {
  const doc = new JSDOM(navXml).window.document;
  const navEl =
    Array.from(doc.querySelectorAll('nav')).find((n) => (n.getAttribute('epub:type') ?? '').includes('toc')) ??
    doc.querySelector('nav');
  const anchors = navEl ? navEl.querySelectorAll('a') : doc.querySelectorAll('a');
  const entries: TocEntry[] = [];
  anchors.forEach((a) => {
    const href = a.getAttribute('href');
    const title = tocTitle(a.textContent);
    if (!href || !title) return;
    const target = splitHref(href, dirname(navPath));
    if (!target) return;
    const li = a.closest('li');
    entries.push({ title, ...target, leaf: !li || !li.querySelector('li') });
  });
  return entries;
}

function parseNcxEntries(ncxXml: string, ncxPath: string): TocEntry[] {
  const doc = new JSDOM(ncxXml, { contentType: 'application/xml' }).window.document;
  const entries: TocEntry[] = [];
  doc.querySelectorAll('navPoint').forEach((navPoint) => {
    const title = tocTitle(navPoint.querySelector('navLabel text')?.textContent);
    const src = navPoint.querySelector('content')?.getAttribute('src');
    if (!title || !src) return;
    const target = splitHref(src, dirname(ncxPath));
    if (!target) return;
    entries.push({ title, ...target, leaf: !navPoint.querySelector('navPoint') });
  });
  return entries;
}

/** Ordered TOC entries from nav.xhtml, else NCX; empty when neither yields any. */
function readTocEntries(zip: AdmZip, opfDir: string, navHref: string | null, ncxHref: string | null): TocEntry[] {
  if (navHref) {
    const navPath = joinZipPath(opfDir, navHref);
    const navXml = readZipEntryText(zip, navPath);
    if (navXml) {
      const entries = parseNavEntries(navXml, navPath);
      if (entries.length > 0) return entries;
    }
  }
  if (ncxHref) {
    const ncxPath = joinZipPath(opfDir, ncxHref);
    const ncxXml = readZipEntryText(zip, ncxPath);
    if (ncxXml) return parseNcxEntries(ncxXml, ncxPath);
  }
  return [];
}

function hasChapterNumber(title: string): boolean {
  return TOC_CHAPTER_NUMBER_RES.some((re) => re.test(title));
}

/** Text of one document plus the offset of every id/name anchor in it. */
function readSpineTextDoc(html: string): Pick<SpineTextDoc, 'norm' | 'raw' | 'anchors'> {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const body = document.body;
  const anchors = new Map<string, { n: number; r: number }>();
  if (!body) return { norm: '', raw: '', anchors };

  const norm: string[] = [];
  const raw: string[] = [];
  let n = 0;
  let r = 0;
  const SHOW_ELEMENT = 0x1;
  const SHOW_TEXT = 0x4;
  const walker = document.createTreeWalker(body, SHOW_ELEMENT | SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      const parent = node.parentNode as Element | null;
      const tag = parent?.nodeName?.toLowerCase();
      if (tag === 'script' || tag === 'style') continue;
      const original = (node.nodeValue ?? '').replace(/\r\n?/g, '\n');
      const collapsed = original.replace(/\s+/g, ' ');
      if (collapsed.trim() === '' && norm.length === 0) continue;
      norm.push(collapsed);
      raw.push(original);
      n += collapsed.length;
      r += original.length;
    } else {
      const el = node as Element;
      for (const attr of ['id', 'name']) {
        const v = el.getAttribute(attr);
        if (v && !anchors.has(v)) anchors.set(v, { n, r });
      }
    }
  }
  return { norm: norm.join(''), raw: raw.join(''), anchors };
}

function selectTocSegments(entries: TocSegment[]): TocSegment[] {
  const numberedCount = entries.filter((e) => e.numbered).length;
  const kept: TocSegment[] = [];

  if (numberedCount >= 5) {
    let lo = -1;
    let hi = -1;
    entries.forEach((e, i) => {
      if (!e.numbered) return;
      if (lo === -1) lo = i;
      hi = i;
    });
    const keptIndexByHref = new Map<string, number>();
    entries.forEach((e, i) => {
      if (TOC_FRONT_MATTER_RE.test(e.title) && !e.numbered) return;
      const longUnnumberedBetween =
        i > lo && i < hi && e.len >= TOC_MIN_SEGMENT_CHARS && !TOC_PART_RE.test(e.title);
      const audible = TOC_AUDIBLE_SECTION_RE.test(e.title) && e.len >= TOC_MIN_SEGMENT_CHARS;
      if (!(e.numbered || longUnnumberedBetween || audible)) return;

      // Two numbered entries pointing at the same place: keep the longer title.
      const prevIdx = keptIndexByHref.get(e.href);
      if (prevIdx !== undefined && e.numbered && kept[prevIdx]!.numbered) {
        if (e.title.length > kept[prevIdx]!.title.length) kept[prevIdx] = e;
        return;
      }
      keptIndexByHref.set(e.href, kept.length);
      kept.push(e);
    });
    return kept;
  }

  for (const e of entries) {
    if (TOC_FRONT_MATTER_RE.test(e.title) || e.len < TOC_MIN_SEGMENT_CHARS) continue;
    kept.push(e);
  }
  return kept;
}

/**
 * Split the book at its TOC anchors. Returns [] when no TOC entry resolves to
 * a spine document or no entry qualifies as a chapter, so the caller can fall
 * back to the per-spine-item behaviour.
 */
function detectChaptersByTocAnchors(zip: AdmZip, spinePaths: string[], toc: TocEntry[]): DetectedChapter[] {
  const docs = new Map<string, SpineTextDoc>();
  let offN = 0;
  let offR = 0;
  const normalizeKey = (p: string): string => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  };

  for (const path of spinePaths) {
    const key = normalizeKey(path);
    if (docs.has(key)) continue;
    const html = readZipEntryText(zip, path);
    if (!html) continue;
    const parsed = readSpineTextDoc(html);
    docs.set(key, { ...parsed, offN, offR });
    offN += parsed.norm.length;
    offR += parsed.raw.length;
  }
  if (docs.size === 0) return [];

  const docList = Array.from(docs.values());
  const fullRaw = docList.map((d) => d.raw).join('');

  const resolved = toc.flatMap((t) => {
    const doc = docs.get(normalizeKey(t.path));
    if (!doc) return [];
    const anchor = t.fragment ? doc.anchors.get(t.fragment) : undefined;
    return [
      {
        t,
        doc,
        startN: doc.offN + (anchor?.n ?? 0),
        startR: doc.offR + (anchor?.r ?? 0),
      },
    ];
  });
  if (resolved.length === 0) return [];

  // Every entry (including section headings that are not candidates
  // themselves) bounds the segment before it.
  const startsN = Array.from(new Set(resolved.map((e) => e.startN))).sort((a, b) => a - b);
  const rawAtN = new Map<number, number>();
  for (const e of resolved) if (!rawAtN.has(e.startN)) rawAtN.set(e.startN, e.startR);

  const segments: TocSegment[] = [];
  for (const e of resolved) {
    if (!e.t.leaf) continue;
    const next = startsN.find((s) => s > e.startN);
    const endN = next ?? e.doc.offN + e.doc.norm.length;
    const endR = next !== undefined ? (rawAtN.get(next) ?? fullRaw.length) : e.doc.offR + e.doc.raw.length;
    segments.push({
      title: e.t.title,
      href: e.t.fragment ? `${e.t.path}#${e.t.fragment}` : e.t.path,
      startN: e.startN,
      endN,
      startR: e.startR,
      endR,
      len: endN - e.startN,
      numbered: hasChapterNumber(e.t.title),
      leaf: true,
    });
  }

  const chapters: DetectedChapter[] = [];
  for (const seg of selectTocSegments(segments)) {
    const text = fullRaw
      .slice(seg.startR, seg.endR)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text) chapters.push({ title: seg.title, text });
  }
  return chapters;
}

function htmlToPlainText(html: string): string {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  if (!body) return '';
  return (body.textContent ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================================
// LLM-based chapter detection for plain / PDF-extracted text
// ============================================================================

interface LlmChapterBoundary {
  title: string;
  startOffset: number;
}

/**
 * Split a flat text blob (e.g. a PDF-extracted `Article`) into chapters by
 * asking Claude for chapter boundaries as structured JSON, mirroring
 * `cleanContentWithLLM` in routes/extract.ts (system prompt + JSON output,
 * same model, same defensive fallback to the original content on failure).
 *
 * If Anthropic isn't configured, or the LLM call fails / returns something
 * unusable, falls back to treating the whole input as a single chapter —
 * callers should always get at least one chapter back.
 */
export async function detectChaptersFromText(text: string, title?: string | null): Promise<DetectedChapter[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot detect chapters: input text is empty');
  }

  if (!anthropic) {
    chapterLogger.warn('Anthropic not configured, falling back to single chapter');
    return [{ title: title ?? 'Chapter 1', text: trimmed }];
  }

  // Short inputs aren't worth splitting.
  if (trimmed.length < 4_000) {
    return [{ title: title ?? 'Chapter 1', text: trimmed }];
  }

  try {
    const boundaries = await requestChapterBoundaries(trimmed, title ?? null);
    if (!boundaries || boundaries.length === 0) {
      return [{ title: title ?? 'Chapter 1', text: trimmed }];
    }

    const chapters: DetectedChapter[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i];
      if (!boundary) continue;
      const nextBoundary = boundaries[i + 1];
      const start = Math.max(0, Math.min(boundary.startOffset, trimmed.length));
      const end = nextBoundary ? Math.max(start, Math.min(nextBoundary.startOffset, trimmed.length)) : trimmed.length;
      const chapterText = trimmed.slice(start, end).trim();
      if (!chapterText) continue;
      chapters.push({ title: boundary.title || `Chapter ${chapters.length + 1}`, text: chapterText });
    }

    if (chapters.length === 0) {
      return [{ title: title ?? 'Chapter 1', text: trimmed }];
    }

    return mergeShortChapters(chapters);
  } catch (error) {
    chapterLogger.error({ error }, 'LLM chapter detection failed, falling back to single chapter');
    return [{ title: title ?? 'Chapter 1', text: trimmed }];
  }
}

async function requestChapterBoundaries(text: string, title: string | null): Promise<LlmChapterBoundary[] | null> {
  if (!anthropic) return null;

  const truncatedText = text.length > LLM_SPLIT_MAX_INPUT_CHARS ? text.slice(0, LLM_SPLIT_MAX_INPUT_CHARS) : text;

  const systemPrompt = `You are a document structure analyzer that finds chapter boundaries in long-form text, for splitting it into an audiobook.

Your job:
1. Read the text and identify natural chapter/section boundaries (explicit headings like "Chapter 1", "Part II", numbered sections, or clear topical breaks in unstructured text).
2. For each chapter, report its title (use the heading text if present, otherwise a short descriptive title you generate) and the exact character offset (0-based, into the text as given to you) where that chapter begins.
3. The first chapter must start at offset 0.
4. Produce at most ${LLM_SPLIT_MAX_CHAPTERS} chapters. If the text has no clear structure, return a small number of large chapters rather than many tiny ones.
5. Offsets must be strictly increasing and correspond to the start of the corresponding chapter's own text in the original input (not the input you were given after any trimming on your end — do not renumber, just report offsets into the exact text supplied).

Respond with ONLY a JSON array, no other text, in this exact shape:
[{"title": "Chapter title", "startOffset": 0}, {"title": "Next chapter title", "startOffset": 1234}]`;

  const userPrompt = title
    ? `Find chapter boundaries in this text titled "${title}":\n\n${truncatedText}`
    : `Find chapter boundaries in this text:\n\n${truncatedText}`;

  const startTime = Date.now();

  const completion = await withFeature('chapter_detection', () => anthropic.messages.create({
    model: LLM_MODEL,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 4000,
    temperature: 0.1,
  }));

  const firstBlock = completion.content[0];
  const raw = firstBlock && firstBlock.type === 'text' ? firstBlock.text : undefined;

  chapterLogger.info({
    responseTimeMs: Date.now() - startTime,
    inputLength: truncatedText.length,
    inputTokens: completion.usage?.input_tokens,
    outputTokens: completion.usage?.output_tokens,
  }, 'Chapter boundaries requested from LLM');

  if (!raw) return null;

  const jsonText = extractJsonArray(raw);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    chapterLogger.warn({ error }, 'Failed to parse LLM chapter boundary JSON');
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const boundaries: LlmChapterBoundary[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { title?: unknown }).title === 'string' &&
      typeof (entry as { startOffset?: unknown }).startOffset === 'number'
    ) {
      boundaries.push({
        title: (entry as { title: string }).title,
        startOffset: (entry as { startOffset: number }).startOffset,
      });
    }
  }

  if (boundaries.length === 0) return null;

  boundaries.sort((a, b) => a.startOffset - b.startOffset);
  const first = boundaries[0];
  if (first && first.startOffset !== 0) first.startOffset = 0;

  return boundaries.slice(0, LLM_SPLIT_MAX_CHAPTERS);
}

function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Fold very short chapters into their neighbor so we don't fan out a TTS job
 * for a one-line "Title Page" / "Copyright" style spine item.
 */
function mergeShortChapters(chapters: DetectedChapter[]): DetectedChapter[] {
  if (chapters.length <= 1) return chapters;

  const merged: DetectedChapter[] = [];
  for (const chapter of chapters) {
    const prev = merged[merged.length - 1];
    if (chapter.text.length < MIN_CHAPTER_CHARS && prev) {
      prev.text = `${prev.text}\n\n${chapter.text}`;
      continue;
    }
    merged.push({ ...chapter });
  }

  // If the very first chapter was itself too short and had nothing to merge
  // into, fold it forward into the next one instead of dropping it.
  const mergedFirst = merged[0];
  const mergedSecond = merged[1];
  if (mergedFirst && mergedSecond && mergedFirst.text.length < MIN_CHAPTER_CHARS) {
    mergedSecond.text = `${mergedFirst.text}\n\n${mergedSecond.text}`;
    merged.shift();
  }

  return merged;
}
