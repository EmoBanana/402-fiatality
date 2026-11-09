/**
 * SSRF guard for seller base URLs (SPEC §5.2, §10).
 * - https only; http is allowed only for localhost / 127.0.0.1 / ::1 in demo mode (the demo sellers).
 * - Every other host must resolve to public addresses only: checked when the seller is registered, and again
 *   at connect time through `guardedLookup` (DNS rebinding), which validates the exact addresses dialed.
 */
import { lookup as dnsLookup, promises as dnsPromises, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { AppError } from "../context";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** URL.hostname without IPv6 brackets or a trailing dot, lowercased. */
export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(normalizeHostname(hostname));
}

const reserved = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  reserved.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT): embeds any IPv4, e.g. ::ffff:0:7f00:1 = 127.0.0.1
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
  ["64:ff9b:1::", 48], // local-use NAT64
] as const) {
  reserved.addSubnet(net, prefix, "ipv6");
}
// IPv4-mapped addresses (::ffff:a.b.c.d) are checked against the IPv4 rules by BlockList itself.

const nat64 = new BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");
const sixToFour = new BlockList();
sixToFour.addSubnet("2002::", 16, "ipv6");

/** Expand an IPv6 address into its 8 16-bit groups (handles "::" and a trailing dotted quad). */
function ipv6Groups(address: string): number[] | null {
  let addr = address.split("%")[0] ?? "";
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted?.[1]) {
    const o = dotted[1].split(".").map(Number);
    addr = `${addr.slice(0, -dotted[1].length)}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  }
  const [head = "", tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? h.length !== 8 : missing < 0) return null;
  const groups = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...t].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True when the address is globally routable (not private, loopback, link-local, multicast, reserved...). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address, "ipv4");
  if (family !== 6) return false;
  if (reserved.check(address, "ipv6")) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  // Embedded IPv4 (NAT64, 6to4) must itself be public.
  if (nat64.check(address, "ipv6")) return isPublicAddress(v4FromGroups(groups[6] ?? 0, groups[7] ?? 0));
  if (sixToFour.check(address, "ipv6")) return isPublicAddress(v4FromGroups(groups[1] ?? 0, groups[2] ?? 0));
  return true;
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return false;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
    // ::ffff:127.x.x.x
    return groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff && (groups[6] ?? 0) >> 8 === 127;
  }
  return false;
}

const unsafe = (message: string) => new AppError(400, "unsafe_url", message);

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolve: ResolveHost = (hostname) => dnsPromises.lookup(hostname, { all: true, verbatim: true });

/** Static checks shared by registration and request time: scheme, credentials, local hosts, IP literals. */
export function checkSellerUrlShape(raw: string, demo: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsafe("Base URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw unsafe("Base URL must use https.");
  if (url.username || url.password) throw unsafe("Base URL must not contain credentials.");
  if (url.search || url.hash) throw unsafe("Base URL must not contain a query string or fragment.");
  const host = normalizeHostname(url.hostname);
  if (LOCAL_HOSTNAMES.has(host)) {
    if (!demo) throw unsafe("Local addresses are only allowed in demo mode.");
    return url;
  }
  if (url.protocol === "http:") throw unsafe("Base URL must use https (http is only allowed for localhost in demo mode).");
  if (isIP(host) && !isPublicAddress(host)) throw unsafe(`${host} is not a public address.`);
  return url;
}

/** Registration-time check: shape plus DNS resolution of the host (every address must be public). */
export async function assertSafeSellerUrl(raw: string, opts: { demo: boolean; resolve?: ResolveHost }): Promise<URL> {
  const url = checkSellerUrlShape(raw, opts.demo);
  const host = normalizeHostname(url.hostname);
  if (LOCAL_HOSTNAMES.has(host) || isIP(host)) return url;
  let addresses: LookupAddress[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    throw unsafe(`Can't resolve ${host}.`);
  }
  if (addresses.length === 0) throw unsafe(`Can't resolve ${host}.`);
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) throw unsafe(`${host} resolves to ${bad.address}, which is not a public address.`);
  return url;
}

/**
 * `lookup` for http.request: resolves like dns.lookup, then refuses to connect when any resolved address is not
 * public (loopback is allowed only when `allowLoopback`, i.e. a localhost seller in demo mode).
 */
export function guardedLookup(allowLoopback: boolean): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      const blocked = list.find((a) => !isPublicAddress(a.address) && !(allowLoopback && isLoopbackAddress(a.address)));
      if (blocked || list.length === 0) {
        const error = Object.assign(new Error(`Refusing to connect to ${hostname} (${blocked?.address ?? "no address"})`), {
          code: "EADDRBLOCKED",
        });
        return callback(error, "", 0);
      }
      if (options.all) return callback(null, list);
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}
