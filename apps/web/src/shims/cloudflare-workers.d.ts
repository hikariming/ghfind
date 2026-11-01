// Minimal typing for the Workers runtime module read by opennext-cloudflare.ts
// (this app's tsconfig uses DOM types, not @cloudflare/workers-types).
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
