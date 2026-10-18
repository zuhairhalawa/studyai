import type { Provider, ProviderOutcome, ProviderRequest } from '../../src/core/ai/provider';

/** An answer that stops in the middle: a pack after its first card (the second is half written), a chat answer mid-sentence. */
function cutOff(text: string, pack: boolean): string {
  if (!pack) return text.slice(0, Math.max(10, Math.floor(text.indexOf('BASIS:') / 2)));
  const first = text.indexOf('"cards":[{');
  const end = text.indexOf('}]', first); // the end of the first card's sources
  const keep = text.slice(0, text.indexOf('}', end + 2) + 1);
  return `${keep},{"type":"qa","front":"A second card that was never fin`;
}

/**
 * A scripted stand-in for Gemini, used ONLY by the local test entry. It reads what the server asked for and answers the
 * way a good model would, so tests can exercise the tutor, the question generator and the grader end to end. Words in the
 * student's last message can trigger failures: FAKE-QUOTA-DAY, FAKE-QUOTA-MIN, FAKE-402, FAKE-500, FAKE-TIMEOUT, FAKE-NOUSAGE; FAKE-SLOW answers after 700 ms (so requests overlap).
 */
export class ScriptedGemini implements Provider {
  calls = 0;

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    this.calls += 1;
    const last = req.messages[req.messages.length - 1]?.content ?? '';
    const err = (status: number, message: string, body: Record<string, unknown> = {}): ProviderOutcome => ({ kind: 'rejected', status, message, ...body });

    if (last.includes('FAKE-QUOTA-DAY')) return err(429, 'You exceeded your current quota (requests per day).', { limit: 'quota-day' });
    if (last.includes('FAKE-QUOTA-MIN')) return err(429, 'Rate limit.', { limit: 'quota-minute' });
    if (last.includes('FAKE-402')) return err(402, 'Payment required.', { limit: 'billing-signal' });
    if (last.includes('FAKE-500')) return { kind: 'unknown', message: 'The API answered with status 500 that does not say whether the call was billed.' };
    if (last.includes('FAKE-TIMEOUT')) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { kind: 'unknown', message: 'The request timed out. It may or may not have been billed.' };
    }

    if (last.includes('FAKE-SLOW')) await new Promise<void>((resolve) => setTimeout(resolve, 700));

    const inputTokens = Math.ceil(((req.system?.length ?? 0) + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4);
    const usage = last.includes('FAKE-NOUSAGE') ? undefined : { input_tokens: inputTokens, output_tokens: 120 };
    const sys = req.system ?? '';
    const text = sys.includes('marking assistant') ? this.grade(last) : sys.includes('marking schemes of university exam questions') ? this.audit(last) : sys.includes('write study material') ? this.generate(sys, last) : this.tutor(sys, last);
    // FAKE-CUTOFF (in the question, or in the exam style for a generated pack): the model hits its output cap mid-answer.
    if (last.includes('FAKE-CUTOFF') || sys.includes('FAKE-CUTOFF')) return { kind: 'ok', text: cutOff(text, sys.includes('write study material')), usage, requestId: `fake_${this.calls}`, truncated: true };
    return { kind: 'ok', text, usage, requestId: `fake_${this.calls}` };
  }

  private tutor(system: string, question: string): string {
    const refs = [...system.matchAll(/<excerpt ref="(S\d+)"/g)].map((m) => m[1]!);
    const cite = refs[0] ? ` [${refs[0]}]` : '';
    if (question.includes('FAKE-OUTSIDE')) return `Short answer${cite}.\n\nBeyond the slides: this connects to complexity theory.\n\nBASIS: lecture\nFOLLOWUPS: What is complexity? | Why does it matter?`;
    if (question.includes('FAKE-NOCITE')) return 'A confident answer with no citation at all.\n\nBASIS: lecture\nFOLLOWUPS: Why? | How?';
    return `A Turing machine reads and writes symbols on an infinite tape${cite}. Each step it moves the head left or right${refs[1] ? ` [${refs[1]}]` : ''}.\n\nBASIS: lecture\nFOLLOWUPS: What is the head? | What is a transition function? | Can the tape be finite?`;
  }

  private grade(user: string): string {
    const ids = [...user.matchAll(/<rubric>[\s\S]*?<\/rubric>/g)].flatMap((m) => [...m[0].matchAll(/id="([^"]+)" marks=([0-9.]+)/g)].map((x) => ({ id: x[1]!, marks: Number(x[2]) })));
    const answer = /<student_answer>([\s\S]*?)<\/student_answer>/.exec(user)?.[1]?.trim() ?? '';
    // First point earned when the answer is not empty; the rest only when the answer is long. A real grader would read it.
    const points = ids.map((p, i) => ({ id: p.id, awarded: answer.length > 3 && (i === 0 || answer.length > 60) ? p.marks : 0, reason: i === 0 ? 'The core idea is present.' : 'Detail is missing.' }));
    return JSON.stringify({ points, feedback: 'Add the missing detail and a concrete example.', missing: ['a worked example'], confidence: 'medium' });
  }

  /**
   * The check of marking points: every point is "asked" with a quote from the question, except a point that carries the words
   * FAKE-NOT-ASKED (padding) or FAKE-PARTLY, and a scenario whose question carries FAKE-DECORATION (a story that changes nothing).
   */
  private audit(escaped: string): string {
    const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const user = unescape(escaped);
    const questions = [...user.matchAll(/<question n="(\d+)" type="(\w+)" marks="[\d.]+">\n([\s\S]*?)\n<\/question>\n<marking_points>\n([\s\S]*?)\n<\/marking_points>/g)].map((m) => {
      const prompt = m[3]!;
      const quote = prompt.split(/\s+/).slice(0, 6).join(' ');
      const points = m[4]!.split('\n').map((line, i) => {
        const asked = line.includes('FAKE-NOT-ASKED') ? 'no' : line.includes('FAKE-PARTLY') ? 'partly' : 'yes';
        return { point: i + 1, asked, quote: asked === 'yes' ? quote : '', note: asked === 'no' ? 'The question never asks for this.' : asked === 'partly' ? 'The question asks for something related.' : '' };
      });
      return { n: Number(m[1]), points, situation: m[2] === 'scenario' || m[2] === 'case' || m[2] === 'attack' ? (prompt.includes('FAKE-DECORATION') ? 'decoration' : 'needed') : 'n/a' };
    });
    return JSON.stringify({ questions });
  }

  private generate(system: string, escaped: string): string {
    // The server escapes lecture text (& < >) so slides cannot inject prompt structure; a model reads it back fine.
    const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const user = unescape(escaped);
    const m = /<!-- studyai-lecture ref=(\S+) hash=([0-9a-f]+) slides=(\d+) -->/.exec(user);
    const title = /## Lecture \S+: (.*)/.exec(user)?.[1]?.trim() ?? 'Lecture';
    const ref = m?.[1] ?? 'L1';
    // A real quote from slide 1: the first body line under its heading.
    const slide1 = /### Slide 1: [^\n]*\n\n([^\n]+)/.exec(user)?.[1] ?? '';
    const quote = slide1.split(/\s+/).slice(0, 8).join(' ');
    const src = quote ? [{ lecture: ref, slide: 1, quote }] : [];
    return JSON.stringify({
      format: 'studyai-pack',
      version: 1,
      generator: 'scripted test model',
      lectures: [{ ref, title, fileHash: m?.[2] ?? '', slideCount: Number(m?.[3] ?? 1) }],
      cards: [{ type: 'qa', front: 'What does the first slide introduce?', back: 'The topic of the lecture.', lecture: ref, basis: 'lecture', tags: ['intro'], sources: src }],
      notes: [],
      questions: this.plannedQuestions(system, user, ref),
    });
  }

  /**
   * Answers the question plan the way a good model would: one question per planned line with the planned type, marks, number of
   * marking points and topic, the points taken from the slides named, and a model answer that contains every point.
   */
  private plannedQuestions(system: string, user: string, ref: string): Record<string, unknown>[] {
    const lines = [...system.matchAll(/^(\d+)\. type "(\w+)", difficulty ([123]), ([\d.]+) marks?, (\d+) marking points?, topic "((?:[^"\\]|\\.)*)", based on slides? ([\d, ]+)$/gm)];
    if (lines.length === 0) return [];
    const bodies = new Map<number, string[]>();
    for (const s of user.matchAll(/### Slide (\d+): [^\n]*\n\n([\s\S]*?)(?=\n### Slide |\n---\n|$)/g)) {
      bodies.set(
        Number(s[1]),
        s[2]!
          .split('\n')
          .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim())
          .filter((l) => l && !l.startsWith('>') && !l.startsWith('[') && !l.startsWith('Speaker') && !l.startsWith('$')),
      );
    }
    return lines.map((l) => {
      const type = l[2]!;
      const difficulty = Number(l[3]);
      const marks = Number(l[4]);
      const points = Number(l[5]);
      const topic = JSON.parse(`"${l[6]!}"`).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') as string;
      const slides = l[7]!.split(',').map((n) => Number(n.trim()));
      const text = slides.flatMap((n) => bodies.get(n) ?? []);
      const ideas = Array.from({ length: points }, (_, i) => text[i] ?? `Another separate idea about ${topic} (${i + 1})`);
      // like a real model, cite every slide the question is built on, with a quote from it
      const sources = slides.flatMap((n) => {
        const quote = ((bodies.get(n) ?? [])[0] ?? '').split(/\s+/).slice(0, 8).join(' ');
        return quote ? [{ lecture: ref, slide: n, quote }] : [];
      });
      // a distinct hook from the slides the question is built on, so two questions about one topic are not the same question
      const hook = (text[0] ?? topic).split(/\s+/).slice(0, 7).join(' ').replace(/[.,;:]+$/, '');
      const common ={ type, marks, difficulty, topic, lectures: [ref], basis: 'lecture', sources };
      if (type === 'mcq') return { ...common, prompt: `Which statement about ${hook.toLowerCase()} is correct?`, options: [{ text: ideas[0], correct: true }, { text: 'A statement the slides do not make', correct: false }, { text: 'The opposite of what the slides say', correct: false }] };
      if (type === 'truefalse') return { ...common, prompt: `${ideas[0]}`, answer: true };
      // each kind of question is written as that kind, the way the prompt asks a model to
      const n = `${points} separate point${points === 1 ? '' : 's'}`;
      const prompts: Record<string, string> = {
        scenario: `A small organisation is working on "${hook}". Its staff describe a concrete situation that they have run into and ask for advice. Using the ideas from the lecture, state ${n} that apply to this situation and say why each one matters.`,
        case: `Read the following case. A team deals with "${hook}" in a project and runs into trouble, and a colleague asks what went wrong and what to do next. (a) Say what the lecture tells you about it. (b) Give ${n} that would help them.`,
        compare: `Compare the ideas behind "${hook}" on ${n}: say how they differ and what they have in common.`,
        attack: `An attacker targets a system because of "${hook}". Describe the attack in a short situation and give ${n} of defence that the lecture supports.`,
        diagram: `The figure on the slide shows "${hook}". Explain what the figure shows, giving ${n}.`,
        calculation: `Using the method in the lecture for "${hook}", work out the result for a case with 4 items and 12 units, showing ${n} of your working.`,
        problem: `Solve this problem with 3 inputs and 5 steps using the method in the lecture for "${hook}": show ${n}.`,
        proof: `Show that the claim about "${hook}" holds, following the argument in the lecture: give ${n} of the proof.`,
        algorithm: `Trace the steps of the algorithm for "${hook}" on a list of 5 items and give ${n}.`,
        programming: `Write code that carries out the procedure for "${hook}", with ${n} that the lecture names.`,
        define: `Define "${hook}" and say what it is for, in ${n}.`,
        long: `Discuss "${hook}" and its consequences, linking at least the ideas the lecture gives, in ${n}.`,
      };
      const prompt = prompts[type] ?? `Explain "${hook}" using the slides: give ${n}.`;
      // a full-marks answer states each point once, in the student's voice, with a short link to the slides
      return { ...common, prompt, asks: [{ quote: `${points} separate point${points === 1 ? '' : 's'}`, count: points }], modelAnswer: `${ideas.map((i) => `${i}, as the slides state`).join('. ')}.`, rubric: ideas.map((t) => ({ text: t, marks: marks / points, ask: 1 })), expectedWords: [12 * marks, 20 * marks] };
    });
  }
}
