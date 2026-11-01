/**
 * Strip contact details from free résumé text (uploaded PDFs) before it
 * leaves the browser, and again on the server. Extraction never needs them,
 * and the editor path already omits email and phone (extract.resumeToText).
 * Dependency-free so the client bundle can use it.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7+ digits with common separators, optionally +country code: phone numbers,
// not years ("2021–2023") or short counts. Separators never include line
// breaks, so a number ending one line cannot swallow the next line's year.
const PHONE = /(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,4}\d{3,4}\b/g;
const MIN_PHONE_DIGITS = 7;

export function redactContact(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(PHONE, (match) => (match.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ? "[phone]" : match));
}

/** Upper bound on uploaded résumé text, matching the extraction prompt cap. */
export const MAX_UPLOAD_CHARS = 20_000;

/** Normalize text pulled from a PDF: collapse runs of blank space, redact, cap. */
export function cleanUploadedText(text: string): string {
  return redactContact(
    text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  ).slice(0, MAX_UPLOAD_CHARS);
}
