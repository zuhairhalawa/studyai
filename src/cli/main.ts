import { resolve } from 'node:path';
import { defaultPromptOptions, extractLectures, formatExtraction, promptText, validatePackFile } from './commands';

const HELP = `StudyAI lecture tool (local only; no network, no AI calls)

  extract <file.pptx>... --out <dir>
      Convert lectures to Markdown with slide numbers (L1, L2, ...) and write a completeness report.
  validate <pack.json> --lectures <file.pptx>...
      Check a study pack against the real slides: schema, lecture matching, every cited quote.
      Exit code 0 only when nothing is skipped and every quote is verified.
  prompt [--exam-style "<text>"] [--amount few|normal|many] [--only notes,cards,questions]
      Print the instructions to give an AI together with the lecture Markdown.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Values after `name` up to the next --flag. */
function many(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith('--'); j++) out.push(args[j]!);
  return out;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'extract') {
    const out = flag(rest, '--out');
    const files = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--out');
    if (!out || files.length === 0) {
      console.error('usage: extract <file.pptx>... --out <dir>');
      return 2;
    }
    const results = await extractLectures(files.map((f) => resolve(f)), resolve(out));
    console.log(formatExtraction(results));
    return 0;
  }
  if (cmd === 'validate') {
    const pack = rest.find((a) => !a.startsWith('--'));
    const lectures = many(rest, '--lectures');
    if (!pack || lectures.length === 0) {
      console.error('usage: validate <pack.json> --lectures <file.pptx>...');
      return 2;
    }
    const r = await validatePackFile(resolve(pack), lectures.map((f) => resolve(f)));
    console.log(r.report);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'prompt') {
    const amount = flag(rest, '--amount');
    const only = flag(rest, '--only')?.split(',');
    console.log(
      promptText({
        ...defaultPromptOptions,
        examStyle: flag(rest, '--exam-style'),
        amount: amount === 'few' || amount === 'many' ? amount : 'normal',
        wants: only ? { notes: only.includes('notes'), cards: only.includes('cards'), questions: only.includes('questions') } : defaultPromptOptions.wants,
      }),
    );
    return 0;
  }
  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
