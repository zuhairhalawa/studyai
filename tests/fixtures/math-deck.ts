import { PNG_1X1, bodySp, buildPptx, equationShape, esc, mr, para, picture, run, simpleSlide, tableFrame, textBox, titleSp, type DeckSpec } from './pptx-builder';

/**
 * A synthetic lecture in the style of a mathematical university course (formulas, a proof, a recurrence, pseudocode, a table, a
 * matrix, a diagram, notation with symbols). All content is invented for the tests; no real lecture is used.
 */

const f = (num: string, den: string) => `<m:f><m:num>${num}</m:num><m:den>${den}</m:den></m:f>`;
const sub = (base: string, s: string) => `<m:sSub><m:e>${base}</m:e><m:sub>${s}</m:sub></m:sSub>`;
const sup = (base: string, s: string) => `<m:sSup><m:e>${base}</m:e><m:sup>${s}</m:sup></m:sSup>`;
const paren = (inner: string) => `<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>${inner}</m:e></m:d>`;
const func = (name: string, arg: string) => `<m:func><m:fName>${mr(name, 'p')}</m:fName><m:e>${arg}</m:e></m:func>`;
/** Words inside a formula, the way PowerPoint stores normal text. */
const nor = (t: string) => `<m:r><m:rPr><m:nor/></m:rPr><m:t>${esc(t)}</m:t></m:r>`;
const sum = (lo: string, hi: string, body: string) => `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${lo}</m:sub><m:sup>${hi}</m:sup><m:e>${body}</m:e></m:nary>`;

/** Gauss: the sum of the first n integers is n(n+1)/2. */
export const SUM_OMML = sum(mr('i=1'), mr('n'), mr('i')) + mr('=') + f(mr('n(n+1)'), mr('2'));
/** The merge-sort recurrence T(n) = 2 T(n/2) + n. */
export const RECURRENCE_OMML = mr('T') + paren(mr('n')) + mr('=2') + mr('T') + paren(f(mr('n'), mr('2'))) + mr('+n');
/** The induction step: the sum up to k+1 is (k+1)(k+2)/2. */
export const STEP_OMML = sum(mr('i=1'), mr('k+1'), mr('i')) + mr('=') + f(paren(mr('k+1')) + paren(mr('k+2')), mr('2'));
/** A cases / equation array: f(n) = n log n, n large. */
export const MASTER_OMML = `<m:eqArr><m:e>${mr('T(n)=Θ(n')}${func('log', mr('n'))}${mr(')')}${mr('&')}${nor('if ')}${mr('f(n)=Θ(n)')}</m:e></m:eqArr>`;
/** An inequality with the characters that need escaping in XML and in the prompts. */
export const BOUND_OMML = mr('T(n)≤c·n') + func('log', mr('n')) + mr(' and a<b>c');
/** A 2x2 matrix. */
export const MATRIX_OMML = `<m:m><m:mr><m:e>${mr('a')}</m:e><m:e>${mr('b')}</m:e></m:mr><m:mr><m:e>${mr('c')}</m:e><m:e>${mr('d')}</m:e></m:mr></m:m>`;
export const DET_OMML = mr('det') + paren(mr('A')) + mr('=ad−bc') + mr(' ') + sup(mr('x'), mr('2')) + sub(mr('y'), mr('i'));

export const PSEUDOCODE = ['MERGE-SORT(A, p, r)', '  if p < r', '    q = floor((p + r) / 2)', '    MERGE-SORT(A, p, q)', '    MERGE-SORT(A, q + 1, r)', '    MERGE(A, p, q, r)'];

const mono = (t: string) => para([run(t, { font: 'Consolas' })], { bullet: 'none' });

export function mathDeckSpec(): DeckSpec {
  const img = { rIdImg1: ['image', '../media/image1.png'] as [string, string], rIdImg2: ['image', '../media/image1.png'] as [string, string] };
  const parts = { 'ppt/media/image1.png': PNG_1X1 };
  return {
    title: 'Divide and conquer',
    slides: [
      { shapes: titleSp(2, 'Algorithms: Divide and Conquer', 'ctrTitle') + bodySp(3, [para('Lecture 5')], 1) },
      simpleSlide('Objectives', ['Understand the divide and conquer paradigm', 'Prove the correctness of a closed form by induction', 'Solve recurrences with the master theorem', 'Analyse merge sort']),
      {
        shapes:
          titleSp(2, 'Notation') +
          bodySp(3, [
            para('ℕ is the set of natural numbers {1, 2, 3, …}'),
            para('∀ n ∈ ℕ means "for every natural number n"'),
            para('A ⊆ B means every element of A is also in B; ∅ is the empty set'),
            para('f(n) ∈ Θ(g(n)) means f grows at the same rate as g; f(n) ∈ O(g(n)) means f grows at most as fast as g'),
            para('log means the logarithm to base 2 throughout'),
          ]),
      },
      {
        shapes: titleSp(2, 'Sum of the first n integers') + bodySp(3, [para('Claim: for every n ≥ 1 the following holds.')]) + equationShape(5, SUM_OMML),
        rels: img,
        parts,
        notes: 'Draw the n = 1 case on the board first, then n = 2, then ask what the pattern is.',
      },
      {
        shapes:
          titleSp(2, 'Proof by induction') +
          bodySp(3, [
            para('Base case: n = 1. The left side is 1 and the right side is 1·2/2 = 1.', { bullet: 'num' }),
            para('Inductive hypothesis: assume the claim holds for n = k.', { bullet: 'num' }),
            para('Inductive step: the sum up to k + 1 is the sum up to k plus (k + 1), which by the hypothesis equals k(k+1)/2 + (k + 1).', { bullet: 'num' }),
            para('Simplifying gives (k + 1)(k + 2)/2, which is the claim for n = k + 1.', { bullet: 'num' }),
            para('Therefore the claim holds for all n ≥ 1. ∎', { bullet: 'num' }),
          ]) +
          equationShape(6, STEP_OMML),
        rels: img,
        parts,
      },
      {
        shapes: titleSp(2, 'Recurrence for merge sort') + bodySp(3, [para('Merge sort splits the array in two halves, sorts each and merges them in linear time.'), para('Its running time T(n) satisfies:')]) + equationShape(5, RECURRENCE_OMML) + equationShape(6, BOUND_OMML),
        rels: img,
        parts,
      },
      {
        shapes:
          titleSp(2, 'The master theorem') +
          bodySp(3, [
            para('Let a ≥ 1 and b > 1 be constants and let T(n) = aT(n/b) + f(n).'),
            para('Case 2: if f(n) ∈ Θ(n^(log_b a)) then T(n) ∈ Θ(n^(log_b a) log n).'),
            para('For merge sort a = 2, b = 2 and f(n) = n, so n^(log_2 2) = n and case 2 applies.'),
          ]) +
          equationShape(5, MASTER_OMML),
        rels: img,
        parts,
      },
      {
        shapes: titleSp(2, 'Algorithm: merge sort') + textBox(4, 700000, 1700000, 7000000, 2400000, PSEUDOCODE.map(mono)) + bodySp(3, [para('The merge step takes two sorted halves and produces one sorted array.')]),
      },
      {
        shapes:
          titleSp(2, 'Running times compared') +
          tableFrame(4, [
            ['Algorithm', 'Best case', 'Worst case', 'Extra space'],
            ['Merge sort', 'O(n log n)', 'O(n log n)', 'O(n)'],
            ['Insertion sort', 'O(n)', 'O(n²)', 'O(1)'],
            ['Quicksort', 'O(n log n)', 'O(n²)', 'O(log n)'],
          ]),
      },
      { shapes: titleSp(2, 'The recursion tree') + picture(4, 'rIdImg1', 800000, 1700000, 6000000, 3500000, ''), rels: img, parts },
      {
        shapes: titleSp(2, 'A matrix example') + bodySp(3, [para('The determinant of a two by two matrix is the product of the diagonal minus the product of the off-diagonal.')]) + equationShape(5, MATRIX_OMML) + equationShape(6, DET_OMML),
        rels: img,
        parts,
      },
      simpleSlide('Summary', ['Divide, conquer, combine', 'Induction proves closed forms', 'The master theorem solves many recurrences', 'Merge sort runs in Θ(n log n)']),
    ],
  };
}

export const mathDeck = (): Uint8Array => buildPptx(mathDeckSpec());
