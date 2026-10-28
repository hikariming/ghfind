import { describe, expect, it } from "vitest";
import { markdownHeadings, markdownParagraphs } from "../detail";

const MD = `---
title: x
---

# Title

Intro paragraph with a [link](https://x.dev) and **bold** words in it.

![chart](/a.svg)

## How it works

\`\`\`ts
const hidden = true;
\`\`\`

| a | b |
|---|---|

- first point that is long enough to keep
- second point

### Results ##
`;

describe("markdown helpers", () => {
  it("keeps prose, unwraps links and emphasis, drops code, images, tables and headings", () => {
    expect(markdownParagraphs(MD)).toEqual([
      "Intro paragraph with a link and bold words in it.",
      "first point that is long enough to keep second point",
    ]);
  });

  it("caps the excerpt length", () => {
    const long = `${"word ".repeat(400)}\n\n${"more ".repeat(50)}`;
    const [first] = markdownParagraphs(long, 4, 100);
    expect(first.length).toBeLessThanOrEqual(101);
    expect(first.endsWith("…")).toBe(true);
  });

  it("lists h2/h3 headings for the table of contents", () => {
    expect(markdownHeadings(MD)).toEqual(["How it works", "Results"]);
  });
});
