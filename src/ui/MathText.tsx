import { LazyMarkdown } from './LazyMarkdown';

/** Text with a formula in it: a $...$ whose inside looks like LaTeX (a command, a power, a subscript, an equals sign, a brace). */
const HAS_MATH = /\$[^$\n]*[\\^_={}][^$\n]*\$/;

/**
 * A short piece of text that may hold a formula, such as a marking point ("The sum is $\frac{n(n+1)}{2}$"): the formula is drawn
 * as maths, inside the line. Anything else is shown exactly as written, so "costs $5 and $10" is never taken for maths.
 */
export function MathText({ children }: { children: string }) {
  if (!HAS_MATH.test(children)) return <>{children}</>;
  return <LazyMarkdown inline>{children}</LazyMarkdown>;
}
