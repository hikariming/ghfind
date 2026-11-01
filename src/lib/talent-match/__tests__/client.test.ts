import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES, checkPdfFile } from "../client";

describe("checkPdfFile", () => {
  const pdf = { name: "cv.pdf", type: "application/pdf", size: 1024 };

  it("accepts PDFs by MIME type, or by extension when the type is missing", () => {
    expect(checkPdfFile(pdf)).toBeNull();
    expect(checkPdfFile({ ...pdf, type: "application/x-pdf" })).toBeNull();
    expect(checkPdfFile({ ...pdf, name: "CV.PDF", type: "" })).toBeNull();
  });

  it("rejects other types, empty files and files over the limit", () => {
    expect(checkPdfFile({ ...pdf, name: "cv.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("pdf_type");
    expect(checkPdfFile({ ...pdf, name: "cv.pdf", type: "image/png" })).toBe("pdf_type");
    expect(checkPdfFile({ ...pdf, name: "cv", type: "" })).toBe("pdf_type");
    expect(checkPdfFile({ ...pdf, size: 0 })).toBe("pdf_empty");
    expect(checkPdfFile({ ...pdf, size: MAX_PDF_BYTES })).toBeNull();
    expect(checkPdfFile({ ...pdf, size: MAX_PDF_BYTES + 1 })).toBe("pdf_too_large");
  });
});
