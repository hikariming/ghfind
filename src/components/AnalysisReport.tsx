import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Shared renderer for project-analysis report markdown. The site does not use
 * @tailwindcss/typography, so `prose` classes would render unstyled; every
 * element is mapped to explicit theme classes instead. Section headings get a
 * divider line so the six-dimension report reads as separated blocks rather
 * than a wall of text.
 */
export function AnalysisReport({ markdown }: { markdown: string }) {
  return (
    <div className="max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: () => null,
          h1: ({ children }) => (
            <h1 className="mb-4 mt-1 text-xl font-black tracking-tight text-zinc-100">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-8 border-t border-white/10 pt-5 text-base font-black text-zinc-100 first:mt-0 first:border-t-0 first:pt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-5 text-sm font-bold text-zinc-200">{children}</h3>
          ),
          p: ({ children }) => <p className="my-2.5 text-sm leading-relaxed text-zinc-300">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1.5 pl-5 text-sm text-zinc-300">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1.5 pl-5 text-sm text-zinc-300">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
          a: ({ children, href }) => (
            <a href={href} className="text-orange-300 hover:underline">
              {children}
            </a>
          ),
          code: ({ children, className }) =>
            className ? (
              <code className={className}>{children}</code>
            ) : (
              <code className="break-all rounded bg-white/5 px-1 py-0.5 font-mono text-[0.85em] text-orange-200">
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-3 text-xs">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <table className="my-3 w-full border-collapse text-sm">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border-b border-white/15 px-2 py-1.5 text-left font-semibold text-zinc-200">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-white/5 px-2 py-1.5 text-zinc-300">{children}</td>
          ),
          hr: () => <hr className="my-6 border-white/10" />,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-orange-400/40 pl-3 text-sm text-zinc-400">
              {children}
            </blockquote>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
