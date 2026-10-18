import { z } from 'zod';
import type { Basis } from '../study/types';
import { extractJson, quoteInText } from '../study/pack';

/** Reading what the model sent back. Model output is untrusted text: nothing here is trusted until it is validated. */

export interface TutorReply {
  /** The answer without the trailing BASIS/FOLLOWUPS lines. */
  body: string;
  /** Excerpt labels the answer cites, in order, only those that were actually sent. */
  cites: string[];
  /** Labels the model cited that were never sent (a sign of invention). */
  unknownCites: string[];
  /** What the model says, then corrected by what we can check. */
  basis: Basis;
  /** Short questions the student could ask next. */
  followups: string[];
  /** True when the answer contains a "Beyond the slides:" paragraph. */
  hasOutside: boolean;
  /** True when the answer says the slides do not cover what was asked ("Not covered on these slides:"). */
  notCovered: boolean;
  /** Words the answer puts in quotation marks as if copied, that appear in nothing that was sent (slides, titles, the student's own words). */
  unverifiedQuotes: string[];
}

const BASIS_RE = /^[ \t]*BASIS:[ \t]*(lecture|derived|outside|uncertain)[ \t]*$/gim;
const FOLLOW_RE = /^[ \t]*FOLLOWUPS:[ \t]*(.*)$/gim;
/** A reply is a few thousand characters; anything far beyond that is cut before it is scanned. */
const MAX_REPLY_CHARS = 100_000;

/** A citation: [S2], and also several labels in one bracket, [S1, S2], which models write often. */
const CITE_GROUP = /\[(S\d{1,3}(?:\s*[,;]\s*S\d{1,3})*)\]/g;
const labelsIn = (group: string): string[] => group.split(/\s*[,;]\s*/);

/** The LAST such line wins: the format asks for them at the very end, and a quoted "BASIS:" earlier in the text must not count. */
function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let found: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) found = m;
  return found;
}

/** Placeholder text copied from the format instructions instead of a real question. */
const PLACEHOLDER_FOLLOWUP = /^(a |the )?(short |follow[- ]?up )?question( \d)?$|^(first|second|third) question$/i;

/** A follow-up chip: angle brackets and quotes the model wrapped around it are dropped; placeholders and fragments are not chips. */
function cleanFollowup(raw: string): string | undefined {
  const s = raw
    .trim()
    .replace(/^[-•\d.\s]+/, '')
    .replace(/^[<"“'‘`]+|[>"”'’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= 3 || s.length > 200 || /[<>]/.test(s) || PLACEHOLDER_FOLLOWUP.test(s)) return undefined;
  return s;
}

/** The answer without code blocks and without "Beyond the slides:" paragraphs: only what the slides are credited with. */
function slideClaims(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n{2,}/)
    .filter((para) => !/^\s*\**beyond the slides:/i.test(para))
    .join('\n\n');
}

/**
 * What sits between quotation marks, line by line. Curly pairs are read as they are written. Straight quotes open and close
 * alternately, so a short quoted term ("LIFO") cannot shift the pairing of the next one; a line with an odd number of straight
 * quotes cannot be paired reliably and is skipped rather than guessed at.
 */
function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/“([^“”]{1,300})”/g)) spans.push(m[1]!);
    const parts = line.replace(/“[^“”]*”/g, ' ').split('"');
    if (parts.length % 2 === 1) for (let i = 1; i < parts.length; i += 2) spans.push(parts[i]!);
  }
  return spans;
}

/**
 * Quoted wording that matches nothing that was sent. `known` is everything the model legitimately saw and may quote: the slide
 * texts and titles and the student's own messages. Short quotes (under four words) are terms, not claims about wording.
 */
function findUnverifiedQuotes(body: string, known: readonly string[]): string[] {
  if (known.length === 0) return [];
  const haystack = known.join('\n');
  const out: string[] = [];
  for (const span of quotedSpans(slideClaims(body))) {
    // a citation written inside the quote ("…infinite [S1] in both directions") is not part of the slide's wording
    const q = span.replace(CITE_GROUP, '').replace(/\s+/g, ' ').trim();
    if (q.length < 12 || q.split(' ').length < 4) continue;
    if (quoteInText(q, haystack) === false && !out.includes(q)) out.push(q);
  }
  return out.slice(0, 5);
}

export function parseTutorReply(rawText: string, sentRefs: readonly string[], noteRefs: ReadonlySet<string> = new Set(), knownTexts: readonly string[] = []): TutorReply {
  const text = rawText.length > MAX_REPLY_CHARS ? rawText.slice(0, MAX_REPLY_CHARS) : rawText;
  const basisMatch = lastMatch(BASIS_RE, text);
  const followMatch = lastMatch(FOLLOW_RE, text);
  let body = text;
  // Cut the two format lines out by position, the later one first so the earlier index stays valid.
  for (const m of [basisMatch, followMatch].filter((x): x is RegExpExecArray => !!x).sort((a, b) => b.index - a.index)) body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
  body = body.trim();

  const refs = [...body.matchAll(CITE_GROUP)].flatMap((m) => labelsIn(m[1]!));
  const known = new Set(sentRefs);
  const cites = [...new Set(refs.filter((r) => known.has(r)))];
  const unknownCites = [...new Set(refs.filter((r) => !known.has(r)))];
  const hasOutside = /(^|\n)\s*\**beyond the slides:/i.test(body);
  const notCovered = /(^|\n)\s*\**not covered on these slides:/i.test(body);
  const unverifiedQuotes = findUnverifiedQuotes(body, knownTexts);

  let basis: Basis = (basisMatch?.[1]?.toLowerCase() as Basis | undefined) ?? 'uncertain';
  // What the model claims is checked against what we can see: a claim of "lecture" needs a real citation and no outside material.
  // A "Beyond the slides" paragraph means knowledge from outside was used, whatever else the answer says about itself.
  if ((basis === 'lecture' || basis === 'derived') && hasOutside) basis = 'outside';
  // Only slides count as support: an answer that cites nothing but the student's own notes is not "on the slides".
  const slideCites = cites.filter((c) => !noteRefs.has(c));
  if ((basis === 'lecture' || basis === 'derived') && slideCites.length === 0) basis = 'uncertain';
  if (unknownCites.length > 0 && basis === 'lecture') basis = 'derived';
  // Wording in quotation marks that is on no slide was not copied from them, so the answer cannot be "on the slides" word for word.
  if (unverifiedQuotes.length > 0 && basis === 'lecture') basis = 'derived';
  // An answer that says the slides do not cover the question cannot be labelled as coming from them.
  if (notCovered && (basis === 'lecture' || basis === 'derived')) basis = hasOutside ? 'outside' : 'uncertain';

  const followups = (followMatch?.[1] ?? '')
    .split('|')
    .map(cleanFollowup)
    .filter((s): s is string => s !== undefined)
    .slice(0, 3);
  return { body, cites, unknownCites, basis, followups, hasOutside, notCovered, unverifiedQuotes };
}

/**
 * Citation labels (S1, S2, …) only mean something inside the request that defined them. Before an answer is stored they are
 * replaced by what they stood for, so the saved text, a copied note and the history sent with the next question all name real
 * slides and never a stale label. A label that was never sent is marked instead of left looking like a source.
 */
export function relabelCitations(body: string, slideOf: (ref: string) => number | undefined, noteRefs: ReadonlySet<string>): string {
  return body.replace(CITE_GROUP, (_all, group: string) => {
    const names = labelsIn(group).map((ref) => {
      if (noteRefs.has(ref)) return 'my note';
      const slide = slideOf(ref);
      return slide === undefined ? 'source not found' : `slide ${slide}`;
    });
    return `[${[...new Set(names)].join(', ')}]`;
  });
}

const GradeJson = z.object({
  points: z.array(z.object({ id: z.string().max(80), awarded: z.number(), reason: z.string().max(500).optional() })).max(60),
  feedback: z.string().max(3_000).optional(),
  missing: z.array(z.string().max(300)).max(20).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});

export interface GradeProposal {
  /** One entry per rubric point, in rubric order, clamped to 0..max in steps of 0.5. */
  points: { id: string; awarded: number; max: number; reason: string }[];
  total: number;
  max: number;
  feedback: string;
  missing: string[];
  confidence: 'low' | 'medium' | 'high';
}

/**
 * What the screen does with the grader's answer. A reply that was cut off at the length limit is never turned into marks, even
 * when the part that arrived happens to be valid JSON: the points that were lost would silently count as zero.
 */
export function readGradeReply(reply: { text: string; truncated?: boolean }, rubric: readonly { id: string; marks: number }[]): { ok: true; proposal: GradeProposal } | { ok: false; error: string } {
  if (reply.truncated) return { ok: false, error: 'The AI ran out of space while marking, so its marks are incomplete and were not used. Try again, or mark it yourself.' };
  try {
    return { ok: true, proposal: parseGradeReply(reply.text, rubric) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The grader’s answer could not be read.' };
  }
}

/** Validates the model's JSON against the real rubric. Never throws on bad marks; throws only if there is no usable JSON at all. */
export function parseGradeReply(text: string, rubric: readonly { id: string; marks: number }[]): GradeProposal {
  const parsed = GradeJson.safeParse(extractJson(text));
  if (!parsed.success) throw new Error('The grader’s answer was not in the expected format. Mark it yourself or try again.');
  const byId = new Map(parsed.data.points.map((p) => [p.id, p]));
  const points = rubric.map((r) => {
    const p = byId.get(r.id);
    const raw = Number.isFinite(p?.awarded) ? (p!.awarded as number) : 0;
    const clamped = Math.min(r.marks, Math.max(0, Math.round(raw * 2) / 2));
    return { id: r.id, awarded: clamped, max: r.marks, reason: p?.reason?.trim() || (p ? '' : 'Not addressed by the grader.') };
  });
  const total = points.reduce((n, p) => n + p.awarded, 0);
  return {
    points,
    total,
    max: rubric.reduce((n, r) => n + r.marks, 0),
    feedback: parsed.data.feedback?.trim() ?? '',
    missing: (parsed.data.missing ?? []).map((m) => m.trim()).filter(Boolean),
    // A grader that does not say how sure it is is treated as unsure.
    confidence: parsed.data.confidence ?? 'low',
  };
}
