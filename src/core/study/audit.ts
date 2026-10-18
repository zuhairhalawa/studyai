import { quoteIsVerbatim } from './match';
import { quoteIsIn } from './pack-quality';
import type { QuestionType } from './types';

/**
 * The AI check of the marking points (task "audit"). The device can count what a question asks for and what the marking points
 * reward, but only a reader of the meaning can tell whether the two match: a six-mark question that asks for five things, or one
 * that asks for "three kinds of error" and rewards three things an attacker can do. This module builds that request from the
 * questions, reads the answer, and turns it into findings that are shown next to the device's own warnings.
 *
 * The AI's word is not taken on trust: it must copy the words of the question that ask for each point, and a point it calls
 * "asked" without a quote that is really in the question is reported as unconfirmed.
 */

export const AUDIT_MAX_QUESTIONS = 8;
const POINT_MAX = 12;

export interface AuditQuestion {
  /** Position of the question in the pack the AI wrote (1-based); sent and returned so findings find their way back. */
  n: number;
  type: QuestionType;
  prompt: string;
  marks: number;
  rubric: { text: string; marks: number }[];
  modelAnswer?: string | undefined;
}

export interface AuditPoint {
  point: number;
  asked: 'yes' | 'partly' | 'no';
  quote: string;
  note: string;
}

export interface AuditVerdict {
  n: number;
  points: AuditPoint[];
  situation?: 'needed' | 'decoration' | 'n/a';
}

export type AuditFindingKind = 'not-asked' | 'partly-asked' | 'unconfirmed' | 'decoration';

export interface AuditFinding {
  /** Which question (the `n` that was sent). */
  n: number;
  /** 1-based marking point the finding is about (as sent); undefined for a finding about the whole question. */
  point?: number;
  /** The wording of that marking point as sent, so the finding can still be matched after other points are removed. */
  pointText?: string;
  kind: AuditFindingKind;
  /** What the AI said about it, one short sentence. */
  note?: string;
}

/** The request data for a set of questions (at most AUDIT_MAX_QUESTIONS; the rest are left out). */
export function auditQuestions(questions: readonly AuditQuestion[]): AuditQuestion[] {
  return questions
    .filter((q) => q.rubric.length > 0 && q.type !== 'mcq' && q.type !== 'truefalse')
    .slice(0, AUDIT_MAX_QUESTIONS)
    .map((q) => ({
      n: q.n,
      type: q.type,
      prompt: q.prompt.slice(0, 4_000),
      marks: q.marks,
      rubric: q.rubric.slice(0, POINT_MAX).map((r) => ({ text: r.text.slice(0, 600), marks: r.marks })),
      ...(q.modelAnswer?.trim() ? { modelAnswer: q.modelAnswer.trim().slice(0, 3_000) } : {}),
    }));
}

function pull(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Reads the AI's answer. Anything that does not fit the shape is left out rather than guessed at; undefined when nothing is usable. */
export function parseAudit(text: string): AuditVerdict[] | undefined {
  const root = pull(text);
  const list = root && typeof root === 'object' ? (root as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(list)) return undefined;
  const out: AuditVerdict[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['n'] !== 'number' || !Number.isInteger(r['n']) || !Array.isArray(r['points'])) continue;
    const points: AuditPoint[] = [];
    for (const p of r['points'] as unknown[]) {
      if (!p || typeof p !== 'object') continue;
      const x = p as Record<string, unknown>;
      if (typeof x['point'] !== 'number' || !Number.isInteger(x['point']) || (x['asked'] !== 'yes' && x['asked'] !== 'partly' && x['asked'] !== 'no')) continue;
      points.push({ point: x['point'], asked: x['asked'], quote: typeof x['quote'] === 'string' ? x['quote'].slice(0, 300) : '', note: typeof x['note'] === 'string' ? x['note'].slice(0, 200) : '' });
    }
    const situation = r['situation'] === 'needed' || r['situation'] === 'decoration' || r['situation'] === 'n/a' ? r['situation'] : undefined;
    out.push({ n: r['n'], points, ...(situation ? { situation } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

const clip = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The finding as a sentence. `point` is the marking point's number now (it moves up when an earlier point is removed). */
export function findingText(f: AuditFinding, point = f.point): string {
  const why = f.note?.trim() ? ` ${f.note.trim().replace(/[.!]*$/, '.')}` : '';
  const label = point !== undefined && f.pointText !== undefined ? `Marking point ${point} ("${clip(f.pointText)}")` : '';
  switch (f.kind) {
    case 'not-asked':
      return `${label} is not asked for by the question.${why}`;
    case 'partly-asked':
      return `${label} is only partly asked for: the question asks for something related, not this.${why}`;
    case 'unconfirmed':
      return `${label}: the AI said the question asks for it but could not show where in the question's own words.`;
    case 'decoration':
      return 'The situation is decoration: the marking points would be the same without it, so this is a recall question with a story in front.';
  }
}

/** The AI's verdicts as findings, checked against the questions that were sent. */
export function auditFindings(verdicts: readonly AuditVerdict[], sent: readonly AuditQuestion[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const byN = new Map(sent.map((q) => [q.n, q]));
  for (const v of verdicts) {
    const q = byN.get(v.n);
    if (!q) continue; // a question that was not sent
    const seen = new Set<number>();
    for (const p of v.points) {
      const pt = q.rubric[p.point - 1];
      if (!pt || seen.has(p.point)) continue;
      seen.add(p.point);
      const base = { n: q.n, point: p.point, pointText: pt.text, ...(p.note.trim() ? { note: p.note.trim() } : {}) };
      if (p.asked === 'no') out.push({ ...base, kind: 'not-asked' });
      else if (p.asked === 'partly') out.push({ ...base, kind: 'partly-asked' });
      else if (!quoteIsVerbatim(p.quote, q.prompt) && !quoteIsIn(p.quote, q.prompt)) out.push({ ...base, kind: 'unconfirmed' });
    }
    if (v.situation === 'decoration' && (q.type === 'scenario' || q.type === 'case' || q.type === 'attack')) out.push({ n: q.n, kind: 'decoration' });
  }
  return out;
}
