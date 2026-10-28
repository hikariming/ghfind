import { createPost } from "@/lib/social-feed/api";
export { listPosts as GET } from "@/lib/social-feed/api";

export function POST(request: Request) { return createPost(request); }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
