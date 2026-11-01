import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_CHARS, cleanUploadedText, redactContact } from "../redact";

describe("redactContact", () => {
  it("removes emails and phone numbers but keeps years, dates and counts", () => {
    const text = "lin.wei+jobs@mail.example.cn | +86 138-0013-8000 | (010) 6253 1234\n2021–2023 · 4 PRs · 41.2k stars · v11";
    expect(redactContact(text)).toBe("[email] | [phone] | [phone]\n2021–2023 · 4 PRs · 41.2k stars · v11");
  });
});

describe("cleanUploadedText", () => {
  it("collapses PDF whitespace and caps the length", () => {
    expect(cleanUploadedText("  Lin\t\tWei \r\n\r\n\r\n\r\nEngineer  ")).toBe("Lin Wei \n\nEngineer");
    expect(cleanUploadedText("a ".repeat(MAX_UPLOAD_CHARS))).toHaveLength(MAX_UPLOAD_CHARS);
  });
});
