// Converts the document to and from OpenDocument Text (.odt), the format of
// LibreOffice Writer, which Word can also open and save.
//
// An .odt file is a zip holding XML: content.xml (the text and its automatic
// styles), styles.xml (named styles and the page), and the pictures.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { TableMap } from '@tiptap/pm/tables';
import { fitToPage, naturalSize } from './images.js';
import { MAX_SPACE } from './spacing.js';
import { columnWidths } from './tables.js';

const MIMETYPE = 'application/vnd.oasis.opendocument.text';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
};
const PREFIX = Object.fromEntries(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]));
const XMLNS = Object.entries(NS)
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(' ');

// The bullets the app draws by default at each depth (CSS disc, circle, square).
const DEFAULT_BULLETS = ['•', '◦', '▪'];
const defaultBullet = (depth) => DEFAULT_BULLETS[Math.min(depth, DEFAULT_BULLETS.length - 1)];
const LIST_LEVELS = 10;

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
};
const IMAGE_EXTENSIONS = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([ext, type]) => [type, ext]));

const PX_PER_INCH = 96;
const POINTS = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, px: 0.75 };

const round = (value) => +value.toFixed(4);
const inches = (px) => `${round(px / PX_PER_INCH)}in`;

// A length such as "0.5in" or "12pt" in points, or null.
function toPoints(length) {
  const match = /^(-?\d*\.?\d+)\s*([a-z]*)$/i.exec(length?.trim() ?? '');
  const factor = match && POINTS[match[2].toLowerCase() || 'pt'];
  return factor ? parseFloat(match[1]) * factor : null;
}

function toPixels(length) {
  const pt = toPoints(length);
  return pt == null ? null : (pt * PX_PER_INCH) / 72;
}

// The first family in a CSS or ODF font list, without quotes.
const firstFamily = (family) => family.split(',')[0].trim().replace(/^["']|["']$/g, '');

const escapeXml = (text) =>
  String(text)
    // Characters XML can't hold at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/* ======================= Saving ======================= */

class OdtWriter {
  constructor(defaults, imageSizes) {
    this.defaults = defaults;
    this.imageSizes = imageSizes;
    this.styles = new Map(); // key -> name
    this.styleXml = [];
    this.counters = {};
    this.fonts = new Set([defaults.font]);
    this.pictures = new Map(); // src -> path in the zip
    this.files = {};
    this.manifest = [];
    this.tableCount = 0;
    this.frameCount = 0;
  }

  // An automatic style with these properties, created the first time it's needed.
  style(prefix, family, properties, parent = '') {
    const key = `${family}|${parent}|${properties}`;
    let name = this.styles.get(key);
    if (!name) {
      this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
      name = `${prefix}${this.counters[prefix]}`;
      this.styles.set(key, name);
      const parentAttr = parent ? ` style:parent-style-name="${parent}"` : '';
      this.styleXml.push(`<style:style style:name="${name}" style:family="${family}"${parentAttr}>${properties}</style:style>`);
    }
    return name;
  }

  // Bullet lists. A list style gives a bullet for each depth; the bullets
  // come from the first list at each depth within this list.
  listStyle(list, depth) {
    const chars = Array.from({ length: LIST_LEVELS }, (_, level) => defaultBullet(level));
    const done = new Set();
    const visit = (node, level) => {
      if (level >= LIST_LEVELS) return;
      if (!done.has(level)) {
        done.add(level);
        if (node.attrs.symbol) chars[level] = node.attrs.symbol;
      }
      node.forEach((item) => item.forEach((child) => child.type.name === 'bulletList' && visit(child, level + 1)));
    };
    visit(list, depth);

    const levels = chars
      .map((char, index) => {
        const indent = (index + 1) * 0.5;
        return (
          `<text:list-level-style-bullet text:level="${index + 1}" text:bullet-char="${escapeXml([...char][0])}">` +
          '<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">' +
          `<style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${indent}in" fo:text-indent="-0.25in" fo:margin-left="${indent}in"/>` +
          '</style:list-level-properties></text:list-level-style-bullet>'
        );
      })
      .join('');
    const key = `list|${chars.join('\u0000')}`;
    let name = this.styles.get(key);
    if (!name) {
      this.counters.L = (this.counters.L ?? 0) + 1;
      name = `L${this.counters.L}`;
      this.styles.set(key, name);
      this.styleXml.push(`<text:list-style style:name="${name}">${levels}</text:list-style>`);
    }
    return name;
  }

  // Block nodes. Tables found in a list are put after the whole list, since
  // an ODF list can't hold a table.
  blocks(parent, hoisted = null) {
    let out = '';
    parent.forEach((node) => {
      if (node.type.name === 'table' && hoisted) hoisted.push(node);
      else out += this.block(node, hoisted);
    });
    return out;
  }

  block(node, hoisted) {
    switch (node.type.name) {
      case 'paragraph':
        return this.paragraph(node);
      case 'bulletList': {
        if (hoisted) return this.list(node, 0, hoisted);
        const tables = [];
        const list = this.list(node, 0, tables);
        return list + tables.map((table) => this.table(table)).join('');
      }
      case 'table':
        return this.table(node);
      default:
        return '';
    }
  }

  list(node, depth, hoisted) {
    const style = this.listStyle(node, depth);
    let items = '';
    node.forEach((item) => {
      let content = '';
      item.forEach((child) => {
        if (child.type.name === 'bulletList') content += this.list(child, depth + 1, hoisted);
        else if (child.type.name === 'table') hoisted.push(child);
        else content += this.block(child, hoisted);
      });
      items += `<text:list-item>${content}</text:list-item>`;
    });
    return `<text:list text:style-name="${style}">${items}</text:list>`;
  }

  paragraph(node) {
    const { textAlign, lineSpacing, spaceBefore, spaceAfter } = node.attrs;
    const props = [];
    if (textAlign && textAlign !== 'left') props.push(`fo:text-align="${textAlign}"`);
    // ODF's 100% is the font's own single spacing, the app's "Single".
    if (lineSpacing != null && lineSpacing !== 1) props.push(`fo:line-height="${round(lineSpacing * 100)}%"`);
    if (spaceBefore) props.push(`fo:margin-top="${round(spaceBefore)}pt"`);
    if (spaceAfter) props.push(`fo:margin-bottom="${round(spaceAfter)}pt"`);
    const style = props.length
      ? this.style('P', 'paragraph', `<style:paragraph-properties ${props.join(' ')}/>`, 'Standard')
      : 'Standard';
    return `<text:p text:style-name="${style}">${this.inlines(node)}</text:p>`;
  }

  inlines(paragraph) {
    let out = '';
    // ODF collapses runs of spaces, as HTML does, so all but the first space
    // of a run (and a space at the start of a line) are written as <text:s/>.
    const space = { previous: true };
    paragraph.forEach((child) => {
      if (child.isText) {
        const text = this.text(child.text, space);
        const style = this.textStyle(child.marks);
        out += style ? `<text:span text:style-name="${style}">${text}</text:span>` : text;
      } else if (child.type.name === 'image') {
        out += this.image(child);
        space.previous = false;
      }
    });
    return out;
  }

  text(text, space) {
    let out = '';
    let spaces = 0;
    const flush = () => {
      if (spaces) out += spaces === 1 ? '<text:s/>' : `<text:s text:c="${spaces}"/>`;
      spaces = 0;
    };
    for (const char of text) {
      if (char === ' ') {
        if (space.previous) spaces++;
        else out += ' ';
        space.previous = true;
        continue;
      }
      flush();
      if (char === '\t') out += '<text:tab/>';
      else if (char === '\n') out += '<text:line-break/>';
      else out += escapeXml(char);
      space.previous = false;
    }
    flush();
    return out;
  }

  textStyle(marks) {
    const props = [];
    for (const mark of marks) {
      const { name } = mark.type;
      if (name === 'bold') {
        props.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"');
      } else if (name === 'italic') {
        props.push('fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"');
      } else if (name === 'underline') {
        props.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      } else if (name === 'textStyle') {
        const { fontFamily, fontSize } = mark.attrs;
        if (fontFamily) {
          const family = firstFamily(fontFamily);
          if (family) {
            this.fonts.add(family);
            props.push(`style:font-name="${escapeXml(family)}"`);
          }
        }
        const size = fontSize && toPoints(fontSize);
        if (size) {
          const pt = `${round(size)}pt`;
          props.push(`fo:font-size="${pt}" style:font-size-asian="${pt}" style:font-size-complex="${pt}"`);
        }
      }
    }
    return props.length ? this.style('T', 'text', `<style:text-properties ${props.join(' ')}/>`) : null;
  }

  // Images are stored inside the file, and sit in the line like a character.
  image(node) {
    const { src, alt } = node.attrs;
    if (!src) return '';
    const size =
      node.attrs.width && node.attrs.height
        ? { width: node.attrs.width, height: node.attrs.height }
        : this.imageSizes.get(src) ?? { width: PX_PER_INCH, height: PX_PER_INCH };

    let href = this.pictures.get(src);
    if (!href) {
      href = this.addPicture(src);
      this.pictures.set(src, href);
    }
    const style = this.style(
      'fr',
      'graphic',
      '<style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" style:wrap="none"/>',
    );
    const title = alt ? `<svg:title>${escapeXml(alt)}</svg:title>` : '';
    return (
      `<draw:frame draw:style-name="${style}" draw:name="Image${++this.frameCount}" text:anchor-type="as-char" ` +
      `svg:width="${inches(size.width)}" svg:height="${inches(size.height)}" draw:z-index="0">` +
      `<draw:image xlink:href="${escapeXml(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
      `${title}</draw:frame>`
    );
  }

  // Puts a data: URL's picture in the zip and returns its path. Any other
  // address is linked to rather than stored.
  addPicture(src) {
    const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(src);
    if (!match) return src;
    const type = match[1].toLowerCase() || 'image/png';
    const bytes = match[2].includes(';base64')
      ? Uint8Array.fromBase64(match[3].replace(/\s/g, ''))
      : strToU8(decodeURIComponent(match[3]));
    const path = `Pictures/image${this.pictures.size + 1}.${IMAGE_EXTENSIONS[type] ?? 'bin'}`;
    // Most pictures are already compressed, so store them as they are.
    this.files[path] = [bytes, { level: type === 'image/svg+xml' || type === 'image/bmp' ? 6 : 0 }];
    this.manifest.push({ path, type });
    return path;
  }

  table(node) {
    const map = TableMap.get(node);
    const widths = columnWidths(node, map).map((width) => Math.round(width));
    const name = `Table${++this.tableCount}`;

    const tableProps = [`style:width="${inches(widths.reduce((a, b) => a + b, 0))}"`, 'table:align="left"'];
    if (node.attrs.spaceBefore) tableProps.push(`fo:margin-top="${round(node.attrs.spaceBefore)}pt"`);
    if (node.attrs.spaceAfter) tableProps.push(`fo:margin-bottom="${round(node.attrs.spaceAfter)}pt"`);
    const tableStyle = this.style('Tbl', 'table', `<style:table-properties ${tableProps.join(' ')}/>`);

    const columns = widths
      .map((width) => {
        const style = this.style(
          'Col',
          'table-column',
          `<style:table-column-properties style:column-width="${inches(width)}"/>`,
        );
        return `<table:table-column table:style-name="${style}"/>`;
      })
      .join('');

    // As on screen: a thin black border, and 2px by 6px of padding.
    const cellStyle = this.style(
      'Cell',
      'table-cell',
      '<style:table-cell-properties fo:border="0.75pt solid #000000" fo:padding-top="0.0208in" ' +
        'fo:padding-bottom="0.0208in" fo:padding-left="0.0625in" fo:padding-right="0.0625in" style:vertical-align="top"/>',
    );

    let rows = '';
    for (let row = 0; row < map.height; row++) {
      const { height } = node.child(row).attrs;
      const rowStyle = height
        ? ` table:style-name="${this.style('Row', 'table-row', `<style:table-row-properties style:min-row-height="${inches(height)}"/>`)}"`
        : '';
      let cells = '';
      for (let col = 0; col < map.width; col++) {
        const offset = map.map[row * map.width + col];
        const rect = map.findCell(offset);
        if (rect.top !== row || rect.left !== col) {
          cells += '<table:covered-table-cell/>';
          continue;
        }
        const cell = node.nodeAt(offset);
        const { colspan, rowspan } = cell.attrs;
        const spans =
          (colspan > 1 ? ` table:number-columns-spanned="${colspan}"` : '') +
          (rowspan > 1 ? ` table:number-rows-spanned="${rowspan}"` : '');
        cells += `<table:table-cell table:style-name="${cellStyle}" office:value-type="string"${spans}>${this.blocks(cell)}</table:table-cell>`;
      }
      rows += `<table:table-row${rowStyle}>${cells}</table:table-row>`;
    }
    return `<table:table table:name="${name}" table:style-name="${tableStyle}">${columns}${rows}</table:table>`;
  }

  fontFaces() {
    const faces = [...this.fonts]
      .map((font) => `<style:font-face style:name="${escapeXml(font)}" svg:font-family="${escapeXml(`'${font}'`)}"/>`)
      .join('');
    return `<office:font-face-decls>${faces}</office:font-face-decls>`;
  }

  write(doc) {
    const body = this.blocks(doc);
    const { font, size } = this.defaults;
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n';

    const content =
      `${xml}<office:document-content ${XMLNS} office:version="1.3">${this.fontFaces()}` +
      `<office:automatic-styles>${this.styleXml.join('')}</office:automatic-styles>` +
      `<office:body><office:text>${body}</office:text></office:body></office:document-content>`;

    // The app's page: US Letter with 1in margins, Times New Roman 12pt.
    const styles =
      `${xml}<office:document-styles ${XMLNS} office:version="1.3">${this.fontFaces()}` +
      '<office:styles>' +
      '<style:default-style style:family="paragraph">' +
      '<style:paragraph-properties fo:line-height="100%" fo:margin-top="0pt" fo:margin-bottom="0pt"/>' +
      `<style:text-properties style:font-name="${escapeXml(font)}" fo:font-size="${size}pt" ` +
      `style:font-size-asian="${size}pt" style:font-size-complex="${size}pt"/>` +
      '</style:default-style>' +
      '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
      '</office:styles>' +
      '<office:automatic-styles><style:page-layout style:name="pm1">' +
      '<style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in" style:print-orientation="portrait" ' +
      'fo:margin-top="1in" fo:margin-bottom="1in" fo:margin-left="1in" fo:margin-right="1in"/>' +
      '</style:page-layout></office:automatic-styles>' +
      '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>' +
      '</office:document-styles>';

    const meta =
      `${xml}<office:document-meta ${XMLNS} office:version="1.3"><office:meta>` +
      `<meta:generator>Glyphein</meta:generator><dc:date>${new Date().toISOString()}</dc:date>` +
      '</office:meta></office:document-meta>';

    const entries = [
      { path: '/', type: MIMETYPE, version: true },
      { path: 'content.xml', type: 'text/xml' },
      { path: 'styles.xml', type: 'text/xml' },
      { path: 'meta.xml', type: 'text/xml' },
      ...this.manifest,
    ];
    const manifest =
      `${xml}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
      entries
        .map(
          ({ path, type, version }) =>
            `<manifest:file-entry manifest:full-path="${escapeXml(path)}" manifest:media-type="${type}"` +
            `${version ? ' manifest:version="1.3"' : ''}/>`,
        )
        .join('') +
      '</manifest:manifest>';

    // The mimetype must come first, uncompressed, so other programs can
    // recognise the file.
    return zipSync({
      mimetype: [strToU8(MIMETYPE), { level: 0 }],
      'content.xml': strToU8(content),
      'styles.xml': strToU8(styles),
      'meta.xml': strToU8(meta),
      ...this.files,
      'META-INF/manifest.xml': strToU8(manifest),
    });
  }
}

// `defaults` is { font, size }: the app's default font family and size in points.
// Resolves to the file's bytes.
export async function documentToOdt(doc, defaults) {
  // Images are normally stored with their size, but measure any that aren't.
  const imageSizes = new Map();
  const unsized = [];
  doc.descendants((node) => {
    if (node.type.name === 'image' && node.attrs.src && !(node.attrs.width && node.attrs.height)) unsized.push(node.attrs.src);
  });
  for (const src of new Set(unsized)) {
    try {
      const size = await naturalSize(src);
      imageSizes.set(src, fitToPage(size.width, size.height));
    } catch {
      // Left at the fallback size.
    }
  }
  return new OdtWriter(defaults, imageSizes).write(doc);
}

/* ======================= Opening ======================= */

const qname = (node) => `${PREFIX[node.namespaceURI] ?? '?'}:${node.localName}`;
const elements = (parent) => [...parent.children];

function attr(element, name) {
  const [prefix, local] = name.split(':');
  return element.getAttributeNS(NS[prefix], local) || null;
}

// A property element's attributes, as { 'fo:font-size': '12pt', ... }.
function propertiesOf(style, kind) {
  const props = {};
  for (const element of elements(style)) {
    if (element.localName !== kind) continue;
    for (const a of element.attributes) props[`${PREFIX[a.namespaceURI] ?? '?'}:${a.localName}`] = a.value;
  }
  return props;
}

// Word's private-use bullets (Symbol and Wingdings fonts) and its "o" bullet.
const WORD_BULLETS = { '': '•', '': '▪', '': '➢', '': '✓', '': '❖', '': '□', o: '◦' };

const EMPTY_PARAGRAPH = { type: 'paragraph' };
const LINE_BREAK = { lineBreak: true };
const PLAIN = { bold: false, italic: false, underline: false, font: null, size: null };
const MAX_REPEAT = 1000;

const count = (value) => Math.min(MAX_REPEAT, Math.max(1, parseInt(value, 10) || 1));

// The styles of both XML files, with ODF's inheritance resolved.
class StyleSheet {
  constructor(documents) {
    this.styles = new Map(); // "family:name" -> element
    this.defaults = new Map(); // family -> element
    this.lists = new Map();
    this.fonts = new Map(); // font-face name -> family
    for (const doc of documents) {
      if (!doc) continue;
      for (const face of doc.getElementsByTagNameNS(NS.style, 'font-face')) {
        const family = attr(face, 'svg:font-family');
        this.fonts.set(attr(face, 'style:name'), family ? firstFamily(family) : attr(face, 'style:name'));
      }
      // content.xml comes last, so its automatic styles win over styles.xml's.
      for (const container of elements(doc.documentElement)) {
        if (!['office:styles', 'office:automatic-styles'].includes(qname(container))) continue;
        for (const element of elements(container)) {
          const name = attr(element, 'style:name');
          const kind = qname(element);
          if (kind === 'style:style') this.styles.set(`${attr(element, 'style:family')}:${name}`, element);
          else if (kind === 'style:default-style') this.defaults.set(attr(element, 'style:family'), element);
          else if (kind === 'text:list-style') this.lists.set(name, element);
        }
      }
    }
  }

  // The style and its ancestors, the document's default first.
  chain(family, name) {
    const chain = [];
    const seen = new Set();
    let style = name && this.styles.get(`${family}:${name}`);
    while (style && !seen.has(style)) {
      seen.add(style);
      chain.unshift(style);
      const parent = attr(style, 'style:parent-style-name');
      style = parent && this.styles.get(`${family}:${parent}`);
    }
    const fallback = this.defaults.get(family);
    if (fallback) chain.unshift(fallback);
    return chain;
  }

  properties(family, name, kind) {
    return Object.assign({}, ...this.chain(family, name).map((style) => propertiesOf(style, kind)));
  }

  // `format` with a style's text properties applied over it.
  textFormat(family, name, format) {
    let result = format;
    for (const style of this.chain(family, name)) result = this.applyText(result, propertiesOf(style, 'text-properties'));
    return result;
  }

  applyText(format, props) {
    const next = { ...format };
    const weight = props['fo:font-weight'];
    if (weight) next.bold = weight === 'bold' || parseInt(weight, 10) >= 600;
    const fontStyle = props['fo:font-style'];
    if (fontStyle) next.italic = fontStyle === 'italic' || fontStyle === 'oblique';
    const underline = props['style:text-underline-style'];
    if (underline) next.underline = underline !== 'none';
    const size = props['fo:font-size'];
    if (size?.endsWith('%')) {
      if (next.size) next.size = (next.size * parseFloat(size)) / 100;
    } else if (size) {
      next.size = toPoints(size) ?? next.size;
    }
    const fontName = props['style:font-name'];
    const fontFamily = props['fo:font-family'];
    if (fontName) next.font = this.fonts.get(fontName) ?? fontName;
    else if (fontFamily) next.font = firstFamily(fontFamily);
    return next;
  }
}

class OdtReader {
  constructor(files, sheet, defaults) {
    this.files = files;
    this.sheet = sheet;
    this.defaults = defaults;
    this.unsizedImages = [];
  }

  marks(format) {
    const marks = [];
    if (format.bold) marks.push({ type: 'bold' });
    if (format.italic) marks.push({ type: 'italic' });
    if (format.underline) marks.push({ type: 'underline' });
    // Only what differs from the app's defaults is stored on the text.
    const attrs = {};
    if (format.font && format.font.toLowerCase() !== this.defaults.font.toLowerCase()) {
      attrs.fontFamily = `"${format.font}"`;
    }
    if (format.size && Math.abs(format.size - this.defaults.size) > 0.01) {
      attrs.fontSize = `${Math.min(400, Math.max(1, +format.size.toFixed(2)))}pt`;
    }
    if (Object.keys(attrs).length) marks.push({ type: 'textStyle', attrs });
    return marks;
  }

  // The block nodes inside an element.
  blocks(parent) {
    return elements(parent).flatMap((element) => this.block(element));
  }

  block(element) {
    switch (qname(element)) {
      case 'text:p':
      case 'text:h':
        return this.paragraphs(element);
      case 'text:list': {
        const list = this.list(element, 0, null);
        return list ? [list] : [];
      }
      case 'table:table': {
        const table = this.table(element);
        return table ? [table] : [];
      }
      case 'draw:frame': {
        // A picture anchored to the page rather than to a line of text.
        const runs = [];
        const after = [];
        this.frame(element, PLAIN, runs, after);
        return runs.length ? [this.paragraph({}, runs), ...after] : after;
      }
      // Deleted text kept for change tracking, comments, and declarations.
      case 'text:tracked-changes':
      case 'office:annotation':
      case 'office:forms':
      case 'text:sequence-decls':
      case 'text:variable-decls':
      case 'text:user-field-decls':
      case 'text:index-source':
        return [];
      // Sections, tables of contents and the like: keep their paragraphs.
      default:
        return this.blocks(element);
    }
  }

  // A text:p or text:h. A line break inside one starts a new paragraph.
  paragraphs(element) {
    const styleName = attr(element, 'text:style-name');
    const props = this.sheet.properties('paragraph', styleName, 'paragraph-properties');
    const attrs = {};

    const align = { center: 'center', end: 'right', right: 'right', justify: 'justify' }[props['fo:text-align']];
    if (align) attrs.textAlign = align;

    const lineHeight = props['fo:line-height'];
    if (lineHeight?.endsWith('%')) {
      const multiple = parseFloat(lineHeight) / 100;
      if (multiple > 0 && Math.abs(multiple - 1) > 0.001) attrs.lineSpacing = round(multiple);
    }

    for (const [name, prop] of [['spaceBefore', 'fo:margin-top'], ['spaceAfter', 'fo:margin-bottom']]) {
      const pt = toPoints(props[prop]);
      if (pt > 0) attrs[name] = Math.min(MAX_SPACE, round(pt));
    }

    const format = this.sheet.textFormat('paragraph', styleName, PLAIN);
    const runs = [];
    const after = [];
    this.inlines(element, format, runs, after, { space: true });

    const lines = [[]];
    for (const run of runs) {
      if (run === LINE_BREAK) lines.push([]);
      else lines.at(-1).push(run);
    }
    return [...lines.map((line) => this.paragraph(attrs, line)), ...after];
  }

  paragraph(attrs, runs) {
    const content = [];
    for (const run of runs) {
      if (run.image) {
        content.push({ type: 'image', attrs: run.image });
        continue;
      }
      if (!run.text) continue;
      const previous = content.at(-1);
      if (previous?.type === 'text' && JSON.stringify(previous.marks) === JSON.stringify(run.marks)) {
        previous.text += run.text;
      } else {
        content.push({ type: 'text', text: run.text, ...(run.marks.length ? { marks: run.marks } : {}) });
      }
    }
    const node = { type: 'paragraph' };
    if (Object.keys(attrs).length) node.attrs = { ...attrs };
    if (content.length) node.content = content;
    return node;
  }

  // Collects the text and pictures of a paragraph into `runs`. Text boxes,
  // which hold whole paragraphs, are put in `after`.
  inlines(parent, format, runs, after, state) {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        // As in HTML, runs of white space count as one space.
        let text = node.data.replace(/[ \t\r\n]+/g, ' ');
        if (state.space && text.startsWith(' ')) text = text.slice(1);
        if (text) {
          runs.push({ text, marks: this.marks(format) });
          state.space = text.endsWith(' ');
        }
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      switch (qname(node)) {
        case 'text:span':
          this.inlines(node, this.sheet.textFormat('text', attr(node, 'text:style-name'), format), runs, after, state);
          break;
        case 'text:s':
          runs.push({ text: ' '.repeat(count(attr(node, 'text:c'))), marks: this.marks(format) });
          state.space = false;
          break;
        case 'text:tab':
          runs.push({ text: '\t', marks: this.marks(format) });
          state.space = false;
          break;
        case 'text:line-break':
          runs.push(LINE_BREAK);
          state.space = true;
          break;
        case 'draw:frame':
          this.frame(node, format, runs, after);
          state.space = false;
          break;
        // Footnotes, comments and deleted-text markers aren't part of the line.
        case 'text:note':
        case 'office:annotation':
        case 'text:change':
        case 'text:soft-page-break':
          break;
        // Links, bookmarks, fields and the like: keep their text.
        default:
          this.inlines(node, format, runs, after, state);
      }
    }
  }

  frame(frame, format, runs, after) {
    for (const image of elements(frame)) {
      if (qname(image) !== 'draw:image') continue;
      const src = this.pictureSource(attr(image, 'xlink:href'));
      if (!src) continue; // Try the next one: a frame can hold the same picture in several formats.

      const title = elements(frame).find((child) => ['svg:title', 'svg:desc'].includes(qname(child)));
      const attrs = { src, alt: title?.textContent || null };
      const width = toPixels(attr(frame, 'svg:width'));
      const height = toPixels(attr(frame, 'svg:height'));
      if (width > 0 && height > 0) Object.assign(attrs, fitToPage(width, height));
      else this.unsizedImages.push(attrs);
      runs.push({ image: attrs });
      return;
    }
    const textBox = elements(frame).find((child) => qname(child) === 'draw:text-box');
    if (textBox) after.push(...this.blocks(textBox));
  }

  // A data: URL for a picture stored in the file, or null.
  pictureSource(href) {
    if (!href) return null;
    const path = decodeURIComponent(href.replace(/^\.\//, ''));
    const bytes = this.files[path];
    const type = IMAGE_TYPES[path.split('.').pop().toLowerCase()];
    if (!bytes || !type) return null;
    return `data:${type};base64,${bytes.toBase64()}`;
  }

  list(element, depth, inheritedStyle) {
    const styleName = attr(element, 'text:style-name') ?? inheritedStyle;
    const items = [];
    for (const item of elements(element)) {
      if (!['text:list-item', 'text:list-header'].includes(qname(item))) continue;
      const content = [];
      for (const child of elements(item)) {
        if (qname(child) === 'text:list') {
          const nested = this.list(child, depth + 1, styleName);
          if (nested) content.push(nested);
        } else {
          content.push(...this.block(child));
        }
      }
      // An item must start with a paragraph.
      if (content[0]?.type !== 'paragraph') content.unshift(EMPTY_PARAGRAPH);
      items.push({ type: 'listItem', content });
    }
    if (!items.length) return null;
    const symbol = this.bulletSymbol(styleName, depth);
    return { type: 'bulletList', ...(symbol ? { attrs: { symbol } } : {}), content: items };
  }

  // The bullet a list style gives at a depth, or null for the app's default.
  // Numbered lists become bullet lists.
  bulletSymbol(styleName, depth) {
    const style = this.sheet.lists.get(styleName);
    if (!style) return null;
    const level = String(Math.min(depth + 1, LIST_LEVELS));
    const levelStyle = elements(style).find((element) => attr(element, 'text:level') === level);
    if (!levelStyle || qname(levelStyle) !== 'text:list-level-style-bullet') return null;
    const char = attr(levelStyle, 'text:bullet-char');
    if (!char) return null;
    const symbol = WORD_BULLETS[char] ?? char;
    return symbol === defaultBullet(depth) ? null : symbol;
  }

  table(element) {
    const sheet = this.sheet;
    const columns = []; // { width, relative }
    const rows = [];

    const collect = (parent) => {
      for (const child of elements(parent)) {
        switch (qname(child)) {
          case 'table:table-column': {
            const props = sheet.properties('table-column', attr(child, 'table:style-name'), 'table-column-properties');
            const column = {
              width: toPixels(props['style:column-width']),
              relative: parseFloat(props['style:rel-column-width']) || null,
            };
            for (let i = count(attr(child, 'table:number-columns-repeated')); i > 0; i--) columns.push(column);
            break;
          }
          case 'table:table-row':
            for (let i = count(attr(child, 'table:number-rows-repeated')); i > 0; i--) rows.push(child);
            break;
          case 'table:table-columns':
          case 'table:table-header-columns':
          case 'table:table-column-group':
          case 'table:table-rows':
          case 'table:table-header-rows':
          case 'table:table-row-group':
            collect(child);
            break;
        }
      }
    };
    collect(element);
    if (!rows.length) return null;

    const tableProps = sheet.properties('table', attr(element, 'table:style-name'), 'table-properties');
    let widths = null;
    if (columns.length && columns.every((column) => column.width > 0)) {
      widths = columns.map((column) => Math.round(column.width));
    } else if (columns.length && columns.every((column) => column.relative > 0)) {
      // Shares of the table's width.
      const total = toPixels(tableProps['style:width']) || 624;
      const sum = columns.reduce((a, column) => a + column.relative, 0);
      widths = columns.map((column) => Math.round((column.relative / sum) * total));
    }

    const tableRows = rows.map((row) => {
      const rowProps = sheet.properties('table-row', attr(row, 'table:style-name'), 'table-row-properties');
      const height = toPixels(rowProps['style:min-row-height'] ?? rowProps['style:row-height']);
      const cells = [];
      let column = 0;
      for (const cell of elements(row)) {
        const kind = qname(cell);
        const repeat = count(attr(cell, 'table:number-columns-repeated'));
        if (kind === 'table:covered-table-cell') {
          column += repeat;
          continue;
        }
        if (kind !== 'table:table-cell') continue;
        const colspan = count(attr(cell, 'table:number-columns-spanned'));
        const rowspan = count(attr(cell, 'table:number-rows-spanned'));
        for (let i = 0; i < repeat; i++) {
          const content = this.blocks(cell);
          const colwidth = widths?.slice(column, column + colspan);
          cells.push({
            type: 'tableCell',
            attrs: { colspan, rowspan, colwidth: colwidth?.length === colspan ? colwidth : null },
            content: content.length ? content : [EMPTY_PARAGRAPH],
          });
          // The other columns it spans each hold a covered cell, counted above.
          column += 1;
        }
      }
      return { type: 'tableRow', ...(height > 0 ? { attrs: { height: Math.round(height) } } : {}), content: cells };
    });

    const attrs = {};
    const before = toPoints(tableProps['fo:margin-top']);
    const after = toPoints(tableProps['fo:margin-bottom']);
    if (before > 0) attrs.spaceBefore = Math.min(MAX_SPACE, round(before));
    if (after > 0) attrs.spaceAfter = Math.min(MAX_SPACE, round(after));
    return { type: 'table', ...(Object.keys(attrs).length ? { attrs } : {}), content: tableRows };
  }

  async sizeImages() {
    for (const attrs of this.unsizedImages) {
      try {
        const size = await naturalSize(attrs.src);
        Object.assign(attrs, fitToPage(size.width, size.height));
      } catch {
        // Shown at its own size.
      }
    }
  }
}

// Reads an .odt file's bytes. `defaults` is as for documentToOdt. Resolves to
// the document as ProseMirror JSON; throws an Error with a message for the user.
export async function odtToDocument(bytes, defaults) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('It is not an OpenDocument file, or it is damaged.');
  }

  const mimetype = files.mimetype && strFromU8(files.mimetype).trim();
  if (mimetype && !mimetype.startsWith(MIMETYPE)) {
    throw new Error('It is not a text document. Only OpenDocument Text (.odt) files can be opened.');
  }
  if (!files['content.xml']) throw new Error('It is not an OpenDocument file, or it is damaged.');

  const parse = (name) => {
    if (!files[name]) return null;
    const doc = new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml');
    return doc.getElementsByTagName('parsererror').length ? null : doc;
  };
  const content = parse('content.xml');
  if (!content) throw new Error('Its text could not be read. It may be password-protected or damaged.');

  const body = content.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!body) throw new Error('It is not a text document. Only OpenDocument Text (.odt) files can be opened.');

  const reader = new OdtReader(files, new StyleSheet([parse('styles.xml'), content]), defaults);
  const blocks = reader.blocks(body);
  await reader.sizeImages();
  return { type: 'doc', content: blocks.length ? blocks : [EMPTY_PARAGRAPH] };
}
