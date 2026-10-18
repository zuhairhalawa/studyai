/**
 * The one edit the checking screen offers on a pack before it is imported: take a marking point out of a question. It works on the
 * pack as the AI wrote it (plain JSON), so the whole pack is checked again afterwards and nothing can go out of step.
 *
 * Taking a point out also takes its marks out of the question: a question that asks for five things is a five-mark question, not a
 * six-mark one with an idea nobody asked for. The last point of a question cannot be removed.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Marks are kept in halves, like everywhere else in the app. */
const toHalf = (n: number): number => Math.round(n * 2) / 2;

/**
 * Removes marking point `point` (0-based) of question `question` (0-based, as written in the pack). Returns the pack unchanged when
 * there is nothing sensible to remove.
 */
export function removeMarkingPoint(raw: unknown, question: number, point: number): unknown {
  if (!isObject(raw) || !Array.isArray(raw['questions'])) return raw;
  const item = raw['questions'][question];
  if (!isObject(item) || !Array.isArray(item['rubric']) || item['rubric'].length <= 1) return raw;
  const gone = item['rubric'][point];
  if (!isObject(gone)) return raw;

  const rubric = (item['rubric'] as unknown[]).filter((_, i) => i !== point);
  const goneAsk = typeof gone['ask'] === 'number' && Number.isInteger(gone['ask']) ? gone['ask'] : undefined;
  let next: Json = { ...item, rubric };
  if (typeof item['marks'] === 'number' && typeof gone['marks'] === 'number') next['marks'] = Math.max(0.5, toHalf(item['marks'] - gone['marks']));

  // The ask this point answered now wants one item fewer; an ask left with nothing is dropped and the later asks move up.
  if (goneAsk !== undefined && Array.isArray(item['asks'])) {
    const asks = item['asks'] as unknown[];
    const target = asks[goneAsk - 1];
    const mapped = (item['rubric'] as unknown[]).filter((p) => isObject(p) && p['ask'] === goneAsk).length;
    // A point that was one too many for its ask (more points answered it than it wants) is exactly what restores the count.
    if (isObject(target) && typeof target['count'] === 'number' && mapped <= target['count']) {
      if (target['count'] <= 1) {
        next['asks'] = asks.filter((_, i) => i !== goneAsk - 1);
        next['rubric'] = rubric.map((p) => (isObject(p) && typeof p['ask'] === 'number' && p['ask'] > goneAsk ? { ...p, ask: p['ask'] - 1 } : p));
      } else {
        next['asks'] = asks.map((a, i) => (i === goneAsk - 1 && isObject(a) ? { ...a, count: (a['count'] as number) - 1 } : a));
      }
    }
  }
  if (Array.isArray(next['asks']) && next['asks'].length === 0) next = Object.fromEntries(Object.entries(next).filter(([k]) => k !== 'asks'));
  return { ...raw, questions: raw['questions'].map((q, i) => (i === question ? next : q)) };
}
