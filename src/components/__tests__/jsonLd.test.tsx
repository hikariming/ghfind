import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonLd } from "../JsonLd";

describe("JsonLd", () => {
  it("escapes `<` so a user-controlled name cannot break out of the script tag", () => {
    // GitHub display names are free text — this is the stored-XSS vector.
    const evil = "</script><script>alert(document.domain)</script>";
    const data = { name: evil, url: "https://ghfind.com/u/x" };
    const html = renderToStaticMarkup(<JsonLd data={data} />);

    expect(html).not.toContain(evil);
    const match = html.match(/<script type="application\/ld\+json">(.*)<\/script>/);
    expect(match).toBeTruthy();
    // Escaping must not change the JSON semantics.
    expect(JSON.parse(match![1])).toEqual(data);
  });
});
