// Next extends RequestInit with its data-cache options; shared src/lib code
// passes them (e.g. `next: { revalidate }` in collections.ts). workerd ignores
// unknown init fields, so only the type needs to exist here.
interface RequestInit {
  next?: { revalidate?: number | false; tags?: string[] };
}
