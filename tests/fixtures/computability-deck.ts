import { PNG_1X1, bodySp, buildPptx, equationShape, esc, mr, para, picture, run, simpleSlide, tableFrame, titleSp, type DeckSpec } from './pptx-builder';

/**
 * A synthetic lecture in the style of a Computability and Complexity course: formal definitions with tuples and symbols (Σ, δ, ε, ∈, ⊆,
 * →, ⟨M, w⟩), exponents and subscripts set as font baselines, a pumping-lemma proof, a Turing machine, the halting problem, reductions,
 * complexity classes and NP-completeness, with state diagrams as pictures and transition tables as tables. All content is invented.
 */

const sup = (t: string) => run(t, { baseline: 30000 });
const sub = (t: string) => run(t, { baseline: -25000 });
const sumOmml = `<m:nary><m:naryPr><m:chr m:val="⋃"/></m:naryPr><m:sub>${mr('k')}</m:sub><m:sup></m:sup><m:e>${mr('TIME(')}<m:sSup><m:e>${mr('n')}</m:e><m:sup>${mr('k')}</m:sup></m:sSup>${mr(')')}</m:e></m:nary>`;
const reduceOmml = `${mr('A ')}<m:sSub><m:e>${mr('≤')}</m:e><m:sub>${mr('m')}</m:sub></m:sSub>${mr(' B')}`;
const img = { rIdImg1: ['image', '../media/image1.png'] as [string, string] };
const parts = { 'ppt/media/image1.png': PNG_1X1 };

export function computabilityDeckSpec(): DeckSpec {
  return {
    title: 'Computability and complexity',
    slides: [
      { shapes: titleSp(2, 'Computability and Complexity', 'ctrTitle') + bodySp(3, [para('Lecture 3: automata, Turing machines, decidability')], 1) },
      simpleSlide('Outline', ['Languages and automata', 'The pumping lemma', 'Turing machines', 'Decidability and reductions', 'Complexity classes']),
      {
        shapes:
          titleSp(2, 'Alphabets and languages') +
          bodySp(3, [
            para('An alphabet Σ is a finite set of symbols, for example Σ = {0, 1}'),
            para('Σ* is the set of all finite strings over Σ; ε is the empty string and |w| is the length of w'),
            para('A language is a set of strings: L ⊆ Σ*'),
            para('Example: L = { w ∈ Σ* | w contains an even number of 0s }'),
            para([run('The string '), run('w'), sup('R'), run(' is w written backwards')]),
          ]),
      },
      {
        shapes:
          titleSp(2, 'Deterministic finite automata') +
          bodySp(3, [
            para('A DFA is a 5-tuple (Q, Σ, δ, q0, F) where Q is a finite set of states, Σ is the alphabet, δ: Q × Σ → Q is the transition function, q0 ∈ Q is the start state and F ⊆ Q is the set of accept states'),
            para('M accepts w if the sequence of states reached while reading w ends in a state of F'),
            para('L(M) is the language of all strings that M accepts'),
          ]),
      },
      {
        shapes:
          titleSp(2, 'Example: even number of 0s') +
          bodySp(3, [para('The machine has two states and flips between them on every 0')]) +
          tableFrame(4, [
            ['State', 'On 0', 'On 1'],
            ['q0 (start, accept)', 'q1', 'q0'],
            ['q1', 'q0', 'q1'],
          ]) +
          picture(5, 'rIdImg1', 800000, 4200000, 3000000, 1500000, ''),
        rels: img,
        parts,
      },
      {
        shapes:
          titleSp(2, 'The pumping lemma for regular languages') +
          bodySp(3, [
            para('If A is regular, there is a number p (the pumping length) such that every string s ∈ A with |s| ≥ p can be written as s = xyz with:'),
            para('1. |y| > 0', { lvl: 1 }),
            para('2. |xy| ≤ p', { lvl: 1 }),
            para([run('3. '), run('xy'), sup('i'), run('z ∈ A for every i ≥ 0')], { lvl: 1 }),
            para('It is used to show that a language is not regular, never that it is'),
          ]),
      },
      {
        shapes:
          titleSp(2, 'Proof: B = {0^n 1^n} is not regular') +
          bodySp(3, [
            para('Assume for contradiction that B is regular, and let p be its pumping length.', { bullet: 'num' }),
            para([run('Take s = 0'), sup('p'), run('1'), sup('p'), run(', which is in B and has length at least p.')], { bullet: 'num' }),
            para('Because |xy| ≤ p, the part y contains only 0s, and |y| > 0 so it contains at least one.', { bullet: 'num' }),
            para([run('Then xy'), sup('2'), run('z has more 0s than 1s, so xy'), sup('2'), run('z ∉ B.')], { bullet: 'num' }),
            para('This contradicts the pumping lemma. Therefore B is not regular. ∎', { bullet: 'num' }),
          ]),
      },
      {
        shapes:
          titleSp(2, 'Turing machines') +
          bodySp(3, [
            para('A Turing machine is a 7-tuple (Q, Σ, Γ, δ, q0, q_accept, q_reject) with a tape alphabet Γ that contains Σ and the blank symbol'),
            para('The transition function is δ: Q × Γ → Q × Γ × {L, R}: read a symbol, write a symbol, move the head left or right'),
            para('A configuration records the tape contents, the head position and the current state'),
            para('M accepts w, rejects w or loops forever on w'),
          ]),
      },
      {
        shapes:
          titleSp(2, 'Example: a machine that accepts 0s followed by 1s') +
          tableFrame(4, [
            ['State', 'Read', 'Write', 'Move', 'Next'],
            ['q0', '0', '0', 'R', 'q0'],
            ['q0', '1', '1', 'R', 'q1'],
            ['q1', '1', '1', 'R', 'q1'],
            ['q1', 'blank', 'blank', 'R', 'q_accept'],
          ]) +
          picture(5, 'rIdImg1', 800000, 4200000, 3000000, 1500000, ''),
        rels: img,
        parts,
      },
      {
        shapes:
          titleSp(2, 'Decidable and recognizable languages') +
          bodySp(3, [
            para('A language is recognizable if some Turing machine accepts exactly the strings in it'),
            para('It is decidable if some Turing machine halts on every input and accepts exactly the strings in it'),
            para([run('A'), sub('TM'), run(' = { ⟨M, w⟩ | M is a Turing machine that accepts w }')]),
            para([run('A'), sub('TM'), run(' is recognizable but not decidable')]),
          ]),
      },
      {
        shapes:
          titleSp(2, 'The halting problem is undecidable') +
          bodySp(3, [
            para('Suppose a machine H decides HALT = { ⟨M, w⟩ | M halts on w }.', { bullet: 'num' }),
            para('Build a machine D that on input ⟨M⟩ runs H on ⟨M, ⟨M⟩⟩ and does the opposite: it loops if H says halts, and halts if H says loops.', { bullet: 'num' }),
            para('Run D on its own description ⟨D⟩.', { bullet: 'num' }),
            para('D halts on ⟨D⟩ exactly when H says D loops on ⟨D⟩, which is a contradiction.', { bullet: 'num' }),
            para('Therefore no such H exists. ∎', { bullet: 'num' }),
          ]),
      },
      {
        shapes:
          titleSp(2, 'Reductions') +
          bodySp(3, [para('A is mapping reducible to B, written as below, if there is a computable function f with w ∈ A if and only if f(w) ∈ B'), para('If A is reducible to B and B is decidable, then A is decidable'), para('If A is undecidable and A reduces to B, then B is undecidable')]) +
          equationShape(5, reduceOmml),
        rels: img,
        parts,
      },
      {
        shapes:
          titleSp(2, 'Complexity classes') +
          bodySp(3, [para('P is the class of languages decided in polynomial time by a deterministic Turing machine'), para('NP is the class of languages whose members can be verified in polynomial time')]) +
          equationShape(5, `${mr('P = ')}${sumOmml}`) +
          tableFrame(4, [
            ['Class', 'Decided or verified by', 'Time'],
            ['P', 'deterministic machine', 'polynomial'],
            ['NP', 'nondeterministic machine or a verifier', 'polynomial'],
          ]),
        rels: img,
        parts,
      },
      {
        shapes:
          titleSp(2, 'NP-completeness') +
          bodySp(3, [
            para('A language B is NP-complete if it satisfies two conditions:'),
            para('1. B is in NP', { lvl: 1 }),
            para('2. every language in NP is polynomial-time reducible to B', { lvl: 1 }),
            para('The Cook-Levin theorem states that SAT is NP-complete'),
            para('To prove that a new language C is NP-complete, show that C is in NP and that a known NP-complete language reduces to C in polynomial time'),
          ]),
      },
      simpleSlide('Summary', ['Automata recognise regular languages', 'Turing machines capture computation', 'The halting problem is undecidable', 'NP-complete problems are the hardest in NP']),
    ],
  };
}

export const computabilityDeck = (): Uint8Array => buildPptx(computabilityDeckSpec());
export { esc };
