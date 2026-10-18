import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * Renders notes, cards and answers: GitHub-style markdown, $maths$ via KaTeX and fenced code with
 * syntax highlighting. Raw HTML in the source is NOT interpreted (react-markdown's default), links
 * are restricted to http(s)/mailto, and KaTeX runs with trust disabled.
 */
const SAFE_URL = /^(https?:|mailto:|#)/i;

export function Markdown({ children, className = '', inline = false }: { children: string; className?: string; /** Render inside a line of text: no paragraph around it. */ inline?: boolean }) {
  const Root = inline ? 'span' : 'div';
  return (
    <Root className={`md ${inline ? 'md-inline' : ''} ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, maxSize: 20, maxExpand: 500 }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        urlTransform={(url) => (SAFE_URL.test(url) ? url : '')}
        components={{
          a: ({ href, children: kids }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {kids}
            </a>
          ),
          // Images in markdown would be remote fetches: never load them.
          img: ({ alt }) => <span className="italic">[image: {alt ?? ''}]</span>,
          ...(inline ? { p: ({ children: kids }: { children?: React.ReactNode }) => <>{kids}</> } : {}),
        }}
      >
        {children}
      </ReactMarkdown>
    </Root>
  );
}
