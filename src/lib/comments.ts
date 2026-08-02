import { USERNAME_RE } from "@/lib/username";

export const COMMENT_MAX_LENGTH = 80;

const SENSITIVE_COMMENT_KEYWORDS = [
  "习近平",
  "毛泽东",
  "习大大",
  "大大",
  "八九六四",
  "六四",
  "天安门",
  "8964",
  "64",
  "中国",
  "共产党",
  "党",
  "人民",
].sort((a, b) => Array.from(b).length - Array.from(a).length);

const SENSITIVE_COMMENT_PATTERN = new RegExp(
  SENSITIVE_COMMENT_KEYWORDS.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gu",
);

export type CommentAuthor =
  | { type: "anonymous" }
  | { type: "github"; username: string; avatarUrl?: string | null };

export type ProfileCommentAuthor = CommentAuthor;

export interface ProfileComment {
  id: string;
  targetUsername: string;
  author: ProfileCommentAuthor;
  text: string;
  createdAt: number;
}

export interface ProfileCommentsResponse {
  comments: ProfileComment[];
}

export interface CreateProfileCommentResponse {
  comment: ProfileComment;
}

export interface BlogComment {
  id: string;
  postSlug: string;
  author: CommentAuthor;
  text: string;
  createdAt: number;
}

export interface BlogCommentsResponse {
  comments: BlogComment[];
}

export interface CreateBlogCommentResponse {
  comment: BlogComment;
}

export function normalizeGitHubUsername(input: string): string | null {
  let value = input.trim();
  const profileUrl = value.match(/github\.com\/([^/?#]+)/i);
  if (profileUrl) value = profileUrl[1] ?? "";
  value = value.replace(/^@/, "");
  return USERNAME_RE.test(value) ? value.toLowerCase() : null;
}

/** Blog slugs are filesystem-backed route identifiers, never user-provided titles. */
export function normalizeBlogSlug(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const slug = input.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

/** Replace every configured sensitive phrase with same-width asterisks. */
export function maskSensitiveCommentText(text: string): string {
  return text.replace(SENSITIVE_COMMENT_PATTERN, (match) => "*".repeat(Array.from(match).length));
}

/** Persistence keeps the original text; sensitive words are masked only when comments are read. */
export function normalizeCommentText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const compact = input.replace(/\s+/g, " ").trim();
  const text = Array.from(compact).slice(0, COMMENT_MAX_LENGTH).join("");
  return text.length > 0 ? text : null;
}
