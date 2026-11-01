import { ApiError, jsonRequest, readText, record } from "./github";

declare global {
  interface Env {
    BYOK_REQUIRE_PUBLIC_ENDPOINT?: boolean;
  }
}

export type AIProviderErrorCode =
  | "invalid_config"
  | "key_required"
  | "storage_unavailable"
  | "unavailable"
  | "rate_limited";
export class AIProviderError extends Error {
  constructor(
    public code: AIProviderErrorCode,
    public status = 400,
  ) {
    super(`AI provider ${code}`);
    this.name = "AIProviderError";
  }
}

function invalid(): never {
  throw new AIProviderError("invalid_config");
}
function unavailable(): never {
  throw new AIProviderError("unavailable", 503);
}
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_BYTES = 32 * 1024;
const MAX_DNS_HOSTS = 8;

function publicHostname(value: string): string {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    ) ||
    !/^[a-z][a-z0-9-]*$/.test(labels.at(-1)!) ||
    /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example|onion|arpa)$/.test(
      hostname,
    )
  )
    invalid();
  return hostname;
}

// This validator accepts only public DNS names. URL parsing also canonicalizes
// alternate integer/hexadecimal IPv4 spellings, which the DNS grammar rejects.
export function canonicalProviderBaseUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2000) invalid();
  const setting = value.trim();
  if (!/^https:\/\//i.test(setting) || /[?#\\\s\x00-\x1f\x7f]/.test(setting))
    invalid();
  try {
    const url = new URL(setting);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      setting.split("/")[2].includes("@")
    )
      invalid();
    url.hostname = publicHostname(url.hostname);
    return url.href.replace(/\/+$/, "");
  } catch {
    return invalid();
  }
}

function publicIPv4(value: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  if (
    parts.some((part, i) => part > 255 || String(part) !== value.split(".")[i])
  )
    return false;
  const [a, b, c] = parts;
  // Conservative exclusions include the IANA special-purpose registries,
  // multicast and reserved ranges, even special-purpose globally routed blocks.
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      ((b === 0 && (c === 0 || c === 2)) ||
        (b === 31 && c === 196) ||
        (b === 52 && c === 193) ||
        b === 88 ||
        b === 168 ||
        (b === 175 && c === 48))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function publicIPv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(value)) return false;
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part)))
    return false;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return false;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((part) => parseInt(part, 16));
  // Only global-unicast 2000::/3. Deny IANA special-purpose protocol,
  // benchmarking/documentation, 6to4, and documentation 3fff::/20 blocks.
  return (
    (words[0] & 0xe000) === 0x2000 &&
    !(
      (words[0] === 0x2001 && words[1] < 0x200) ||
      (words[0] === 0x2001 && words[1] === 0xdb8) ||
      words[0] === 0x2002 ||
      (words[0] === 0x3fff && words[1] < 0x1000) ||
      (words[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000)
    )
  );
}

async function dnsQuery(hostname: string, type: 1 | 28, signal: AbortSignal) {
  const query = new URL(DOH_ENDPOINT);
  query.searchParams.set("name", hostname);
  query.searchParams.set("type", String(type));
  const response = await fetch(query.href, {
    headers: { Accept: "application/dns-json" },
    redirect: "manual",
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 429) throw new AIProviderError("rate_limited", 429);
    unavailable();
  }
  return record(JSON.parse(await readText(response, signal, MAX_DNS_BYTES)));
}

async function verifyPublicDNS(hostname: string, deadline: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new AIProviderError("unavailable", 503));
      },
      Math.max(1, Math.min(5000, deadline - Date.now())),
    );
  });
  try {
    if (deadline <= Date.now()) unavailable();
    await Promise.race([
      timeout,
      (async () => {
        const pending = [hostname],
          seen = new Set<string>();
        const edges = new Map<string, Set<string>>();
        let addresses = 0;
        while (pending.length) {
          const host = pending.shift()!;
          if (seen.has(host)) continue;
          if (seen.size >= MAX_DNS_HOSTS) unavailable();
          seen.add(host);
          const responses = await Promise.all([
            dnsQuery(host, 1, controller.signal),
            dnsQuery(host, 28, controller.signal),
          ]);
          let hostAddresses = 0,
            aliases = 0;
          for (const response of responses) {
            if (response.Status !== 0 || response.TC === true) unavailable();
            const answers =
              response.Answer === undefined ? [] : response.Answer;
            if (!Array.isArray(answers) || answers.length > 64) unavailable();
            for (const value of answers) {
              const answer = record(value);
              if (
                typeof answer.name !== "string" ||
                typeof answer.data !== "string"
              )
                unavailable();
              const name = publicHostname(answer.name);
              if (answer.type === 1 || answer.type === 28) {
                if (
                  !(answer.type === 1
                    ? publicIPv4(answer.data)
                    : publicIPv6(answer.data))
                )
                  unavailable();
                hostAddresses++;
                addresses++;
              } else if (answer.type === 5) {
                const target = publicHostname(answer.data);
                const targets = edges.get(name) ?? new Set<string>();
                targets.add(target);
                edges.set(name, targets);
                if (targets.size > 1) unavailable();
                aliases++;
                if (!seen.has(target)) pending.push(target);
              } else unavailable();
            }
          }
          if (!hostAddresses && !aliases) unavailable();
        }
        const visiting = new Set<string>(),
          visited = new Set<string>();
        const checkCycle = (host: string) => {
          if (visiting.has(host)) unavailable();
          if (visited.has(host)) return;
          visiting.add(host);
          for (const target of edges.get(host) ?? []) checkCycle(target);
          visiting.delete(host);
          visited.add(host);
        };
        for (const host of seen) checkCycle(host);
        if (!addresses) unavailable();
      })(),
    ]);
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    unavailable();
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

// DNS is checked for every request, never cached here. Workers fetch resolves
// again and cannot pin these addresses: this mitigates SSRF, not DNS rebinding
// races. No private/VPC bindings are used; redirects never forward credentials.
export async function aiJsonRequest(
  env: Env,
  url: string,
  init: RequestInit,
  deadline: number,
): Promise<unknown> {
  if (env.BYOK_REQUIRE_PUBLIC_ENDPOINT) {
    const endpoint = canonicalProviderBaseUrl(url);
    await verifyPublicDNS(new URL(endpoint).hostname, deadline);
  }
  // Keep existing provider HTTP/quota retry semantics; errors contain no body/key.
  try {
    return await jsonRequest(url, init, deadline);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new AIProviderError("unavailable", 503);
  }
}
