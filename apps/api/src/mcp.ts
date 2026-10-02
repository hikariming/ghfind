/**
 * /mcp for the API Worker. The Next route module builds its handler at import
 * time (mcp-handler starts a setInterval), which Workers forbid in global
 * scope; OpenNext only imports route modules per request. Import it lazily on
 * first use instead — the bundler keeps it in this Worker, evaluated then.
 */
type Handler = (request: Request) => Promise<Response>;

let route: Promise<{ GET: Handler; POST: Handler }> | null = null;
const load = () => (route ??= import("@/app/mcp/route") as Promise<{ GET: Handler; POST: Handler }>);

export async function GET(request: Request) {
  return (await load()).GET(request);
}

export async function POST(request: Request) {
  return (await load()).POST(request);
}
