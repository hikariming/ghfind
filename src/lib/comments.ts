import { USERNAME_RE } from "@/lib/username";

export const COMMENT_MAX_LENGTH = 80;

export type ProfileCommentAuthor =
  | { type: "anonymous" }
  | { type: "github"; username: string; avatarUrl?: string | null };

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

export function normalizeGitHubUsername(input: string): string | null {
  let value = input.trim();
  const profileUrl = value.match(/github\.com\/([^/?#]+)/i);
  if (profileUrl) value = profileUrl[1] ?? "";
  value = value.replace(/^@/, "");
  return USERNAME_RE.test(value) ? value.toLowerCase() : null;
}

export function normalizeCommentText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const compact = input.replace(/\s+/g, " ").trim();
  const text = Array.from(compact).slice(0, COMMENT_MAX_LENGTH).join("");
  return text.length > 0 ? text : null;
}
