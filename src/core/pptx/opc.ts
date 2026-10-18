import { PptxError } from './errors';
import type { ExtractionLimits } from './limits';
import { ZipArchive } from './zip';
import { attr, kids, parseXml, type XNode } from './xml';

/** Relationship from one OPC part to another resource. */
export interface Rel {
  id: string;
  /** Last path segment of the relationship type URI, e.g. "slideLayout", "image", "hyperlink". */
  type: string;
  /** Resolved part name (no leading slash) for internal targets, the raw URL for external ones. */
  target: string;
  external: boolean;
}

/** Part name of the relationships part belonging to `part`. */
export function relsPartFor(part: string): string {
  const i = part.lastIndexOf('/');
  const dir = i >= 0 ? part.slice(0, i + 1) : '';
  const file = i >= 0 ? part.slice(i + 1) : part;
  return `${dir}_rels/${file}.rels`;
}

/** Resolve a relationship target relative to its source part. */
export function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return normalise(target.slice(1));
  const i = sourcePart.lastIndexOf('/');
  const base = i >= 0 ? sourcePart.slice(0, i + 1) : '';
  return normalise(base + target);
}

function normalise(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function mimeFromName(name: string): string | undefined {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      jpe: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      emf: 'image/x-emf',
      wmf: 'image/x-wmf',
      tif: 'image/tiff',
      tiff: 'image/tiff',
    } as Record<string, string>
  )[ext];
}

/** Identify an image by magic bytes (never trust the extension alone). */
export function sniffImageMime(b: Uint8Array): string | undefined {
  const at = (i: number) => b[i] ?? 0;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return 'image/webp';
  }
  if (at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a && at(3) === 0x00) return 'image/tiff';
  if (at(0) === 0x4d && at(1) === 0x4d && at(2) === 0x00 && at(3) === 0x2a) return 'image/tiff';
  if (at(0) === 0xd7 && at(1) === 0xcd && at(2) === 0xc6 && at(3) === 0x9a) return 'image/x-wmf';
  if (at(0) === 0x01 && at(1) === 0x00 && at(2) === 0x00 && at(3) === 0x00 && at(40) === 0x20 && at(41) === 0x45 && at(42) === 0x4d && at(43) === 0x46) {
    return 'image/x-emf';
  }
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 512))).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return undefined;
}

export const BROWSER_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml']);

/** A readable OOXML package with cached XML parts and relationships. */
export class Package {
  readonly zip: ZipArchive;
  private readonly xmlCache = new Map<string, XNode>();
  private readonly relsCache = new Map<string, Map<string, Rel>>();

  constructor(data: Uint8Array, limits: ExtractionLimits) {
    this.zip = new ZipArchive(data, limits);
  }

  has(part: string): boolean {
    return this.zip.has(part);
  }

  /** Parse an XML part. Cached unless `cache` is false (use for one-shot slide parts). */
  xml(part: string, cache = true): XNode {
    const hit = this.xmlCache.get(part);
    if (hit) return hit;
    if (!this.zip.has(part)) throw new PptxError('NOT_PPTX', `Required part is missing: ${part}`);
    const root = parseXml(this.zip.read(part), part);
    if (cache) this.xmlCache.set(part, root);
    return root;
  }

  tryXml(part: string, cache = true): XNode | undefined {
    if (!this.zip.has(part)) return undefined;
    try {
      return this.xml(part, cache);
    } catch {
      return undefined;
    }
  }

  bytes(part: string): Uint8Array {
    return this.zip.read(part);
  }

  rels(part: string): Map<string, Rel> {
    const hit = this.relsCache.get(part);
    if (hit) return hit;
    const map = new Map<string, Rel>();
    const relsPart = relsPartFor(part);
    if (this.zip.has(relsPart)) {
      const root = parseXml(this.zip.read(relsPart), relsPart);
      for (const r of kids(root, 'rel:Relationship')) {
        const id = attr(r, 'Id');
        const target = attr(r, 'Target');
        const typeUri = attr(r, 'Type') ?? '';
        if (!id || target === undefined) continue;
        const external = attr(r, 'TargetMode') === 'External';
        map.set(id, {
          id,
          type: typeUri.slice(typeUri.lastIndexOf('/') + 1),
          target: external ? target : resolveTarget(part, target),
          external,
        });
      }
    }
    this.relsCache.set(part, map);
    return map;
  }

  relsOfType(part: string, type: string): Rel[] {
    return [...this.rels(part).values()].filter((r) => r.type === type);
  }

  /** Content type of a part, from [Content_Types].xml (Override first, then Default by extension). */
  contentType(part: string): string | undefined {
    if (!this.contentTypes) {
      const map = { overrides: new Map<string, string>(), defaults: new Map<string, string>() };
      const root = this.tryXml('[Content_Types].xml');
      for (const n of root?.children ?? []) {
        const ct = attr(n, 'ContentType');
        if (!ct) continue;
        if (n.name === 'ct:Override') map.overrides.set((attr(n, 'PartName') ?? '').replace(/^\//, '').toLowerCase(), ct);
        else if (n.name === 'ct:Default') map.defaults.set((attr(n, 'Extension') ?? '').toLowerCase(), ct);
      }
      this.contentTypes = map;
    }
    const ov = this.contentTypes.overrides.get(part.toLowerCase());
    if (ov) return ov;
    return this.contentTypes.defaults.get(part.slice(part.lastIndexOf('.') + 1).toLowerCase());
  }

  private contentTypes?: { overrides: Map<string, string>; defaults: Map<string, string> };
}
