import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Figure } from "./Figure";

/**
 * Server-rendered article body — reuses the react-markdown pipeline already
 * proven in the roast report (zero client JS for long-form prose). Headings
 * get stable ids so section links survive translation as long as translators
 * keep heading text consistent per locale.
 */

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

const heading = (Tag: "h2" | "h3") =>
  function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(textOf(children));
    return (
      <Tag id={id}>
        <a href={`#${id}`} className="no-underline">
          {children}
        </a>
      </Tag>
    );
  };

export function PostBody({ body }: { body: string }) {
  return (
    <div className="post">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: Figure as never,
          h2: heading("h2"),
          h3: heading("h3"),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
