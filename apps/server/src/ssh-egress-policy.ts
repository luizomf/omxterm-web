// SSRF egress allowlist for the broker (#4). The broker dials a user-provided
// SSH target, so without a guard it can be aimed at loopback, link-local
// (169.254.169.254 cloud metadata), other RFC1918 hosts, or used as an open
// relay out to the internet. This restricts which resolved IPs the broker may
// connect to.
//
// Opt-in by design: when OMXTERM_SSH_ALLOWED_CIDR is unset the policy is
// "unrestricted" so the localhost demo keeps working. Once set, it is
// default-deny — only addresses inside the listed CIDRs pass, so loopback and
// link-local are blocked unless explicitly listed. This is the network-reach
// control; it does NOT replace per-target SSH auth (the user still supplies
// credentials and confirms the host-key fingerprint).
//
// Validation resolves the host here, at the boundary, and the caller pins the
// validated IP into the dial: the probe and SshTerminalSession.connect dial the
// first canonical address in decision.addresses, not the hostname, so ssh2 never
// re-resolves and a hostname cannot rebind in the window between this check
// and the dial (#26). The hostname is kept only for audit/readability. IP-literal
// targets resolve to themselves, and unrestricted mode resolves nothing — there
// the dial keeps using the hostname for the localhost demo. See ssh.ts
// (sshDialHost / hostVerifier) and docs/how-it-works.md.

import { lookup } from "node:dns/promises";
import { BlockList, isIP, SocketAddress } from "node:net";

const ALLOWED_CIDR_HINT =
  "Set OMXTERM_SSH_ALLOWED_CIDR to a comma-separated list of IPv4/IPv6 CIDRs " +
  '(a bare address is treated as a single host), e.g. "10.100.0.0/24,10.0.0.5". ' +
  "Leave it unset to allow any target (single-user/localhost only). Wildcards are not allowed.";

export type SshEgressPolicy =
  | { readonly kind: "unrestricted" }
  | {
      readonly kind: "allowlist";
      readonly cidrs: readonly string[];
      // Node's BlockList intentionally cross-matches IPv4 and IPv4-mapped IPv6.
      // Separate stores make the family selected by endpoint normalization an
      // authorization boundary rather than a hint passed to one mixed matcher.
      readonly allowedIpv4: BlockList;
      readonly allowedIpv6: BlockList;
    };

export type ResolvedAddress = {
  readonly address: string;
  readonly family: number;
};

// Injected so the boundary check stays testable without real DNS.
export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

export type EgressRejectionReason =
  | "resolution_failed"
  | "resolution_empty"
  | "invalid_resolver_result"
  | "invalid_resolved_address"
  | "invalid_resolved_address_family"
  | "resolved_address_family_mismatch"
  | "scoped_resolved_address"
  | "target_not_in_allowlist";

export type EgressDecision =
  | { readonly allowed: true; readonly addresses: readonly string[] }
  | { readonly allowed: false; readonly reason: EgressRejectionReason };

type AddressFamily = "ipv4" | "ipv6";
type CanonicalEndpoint = {
  readonly address: string;
  readonly family: AddressFamily;
};
type EndpointNormalization =
  | { readonly ok: true; readonly endpoint: CanonicalEndpoint }
  | { readonly ok: false; readonly reason: EgressRejectionReason };

/**
 * Resolve a host to all of its IP addresses using the system resolver. IP
 * literals resolve to themselves without touching the network.
 */
export const resolveHostAddresses: HostResolver = (host) =>
  lookup(host, { all: true });

/**
 * Parse the OMXTERM_SSH_ALLOWED_CIDR value into an egress policy.
 *
 * Fails closed at boot: an empty/unset value yields the explicit `unrestricted`
 * policy (documented escape hatch), while a non-empty value with the `*`
 * wildcard or any malformed CIDR throws instead of silently allowing the wrong
 * set. Each entry is an unscoped IPv4/IPv6 CIDR, or a bare address taken as a
 * single host. Scoped and IPv4-mapped IPv6 entries fail clearly; mapped resolver
 * results are authorized only through their equivalent IPv4 policy.
 *
 * @example parseSshEgressAllowlist('10.100.0.0/24, 10.0.0.5')
 */
export function parseSshEgressAllowlist(
  rawValue: string | undefined,
): SshEgressPolicy {
  const entries = (rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) return { kind: "unrestricted" };

  const allowedIpv4 = new BlockList();
  const allowedIpv6 = new BlockList();
  for (const entry of entries) {
    addCidrEntry(allowedIpv4, allowedIpv6, entry);
  }
  return { kind: "allowlist", cidrs: entries, allowedIpv4, allowedIpv6 };
}

/**
 * Decide whether the broker may open an SSH connection to `host` under `policy`.
 *
 * `unrestricted` allows without resolving (preserving prior behavior). Otherwise
 * the host is resolved and every original address/family pair must validate
 * before canonicalization. Every canonical endpoint must fall inside its exact
 * family allowlist; an empty/failed resolution or any invalid/out-of-list result
 * is denied, so a multi-record hostname cannot smuggle a blocked IP past the
 * check. Approved addresses retain resolver order.
 */
export async function checkSshEgress(
  host: string,
  policy: SshEgressPolicy,
  resolveHost: HostResolver,
): Promise<EgressDecision> {
  if (policy.kind === "unrestricted") return { allowed: true, addresses: [] };

  let resolved: ResolvedAddress[];
  try {
    resolved = await resolveHost(host);
  } catch {
    return { allowed: false, reason: "resolution_failed" };
  }

  if (!Array.isArray(resolved)) {
    return { allowed: false, reason: "invalid_resolver_result" };
  }
  if (resolved.length === 0)
    return { allowed: false, reason: "resolution_empty" };

  const addresses: string[] = [];
  for (const entry of resolved) {
    const normalized = normalizeResolvedEndpoint(entry);
    if (!normalized.ok) return { allowed: false, reason: normalized.reason };

    const { address, family } = normalized.endpoint;
    const allowed = family === "ipv6" ? policy.allowedIpv6 : policy.allowedIpv4;
    if (!allowed.check(address, family)) {
      return { allowed: false, reason: "target_not_in_allowlist" };
    }
    addresses.push(address);
  }

  return { allowed: true, addresses };
}

function normalizeResolvedEndpoint(entry: unknown): EndpointNormalization {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof (entry as Partial<ResolvedAddress>).address !== "string"
  ) {
    return { ok: false, reason: "invalid_resolver_result" };
  }

  const { address, family } = entry as ResolvedAddress;
  const textualFamily = isIP(address);
  if (textualFamily === 0) {
    return { ok: false, reason: "invalid_resolved_address" };
  }
  if (family !== 4 && family !== 6) {
    return { ok: false, reason: "invalid_resolved_address_family" };
  }
  if (family !== textualFamily) {
    return { ok: false, reason: "resolved_address_family_mismatch" };
  }
  // SocketAddress canonicalizes by discarding a zone identifier. Reject it
  // only after validating the original family, and before that information can
  // be lost or compared against an unscoped policy entry.
  if (textualFamily === 6 && address.includes("%")) {
    return { ok: false, reason: "scoped_resolved_address" };
  }

  try {
    return { ok: true, endpoint: canonicalEndpoint(address, textualFamily) };
  } catch {
    return { ok: false, reason: "invalid_resolved_address" };
  }
}

function canonicalEndpoint(address: string, family: 4 | 6): CanonicalEndpoint {
  if (family === 4) {
    return {
      address: new SocketAddress({ address, family: "ipv4" }).address,
      family: "ipv4",
    };
  }

  const canonicalIpv6 = new SocketAddress({
    address,
    family: "ipv6",
  }).address;
  const mappedIpv4 = mappedIpv4AddressFromCanonical(canonicalIpv6);
  if (mappedIpv4 !== undefined) {
    return {
      address: new SocketAddress({
        address: mappedIpv4,
        family: "ipv4",
      }).address,
      family: "ipv4",
    };
  }
  return { address: canonicalIpv6, family: "ipv6" };
}

function mappedIpv4Address(address: string): string | undefined {
  const canonicalIpv6 = new SocketAddress({
    address,
    family: "ipv6",
  }).address;
  return mappedIpv4AddressFromCanonical(canonicalIpv6);
}

function mappedIpv4AddressFromCanonical(
  canonicalAddress: string,
): string | undefined {
  if (!canonicalAddress.startsWith("::ffff:")) return undefined;
  const candidate = canonicalAddress.slice("::ffff:".length);
  return isIP(candidate) === 4 ? candidate : undefined;
}

function addCidrEntry(
  allowedIpv4: BlockList,
  allowedIpv6: BlockList,
  entry: string,
): void {
  if (entry === "*") {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR does not allow the wildcard "*". ${ALLOWED_CIDR_HINT}`,
    );
  }

  const slashIndex = entry.indexOf("/");
  if (slashIndex === -1) {
    addSingleAddress(allowedIpv4, allowedIpv6, entry);
    return;
  }

  const address = entry.slice(0, slashIndex);
  const prefix = entry.slice(slashIndex + 1);
  const type = addressType(address, entry);
  const maxPrefix = type === "ipv6" ? 128 : 32;
  const prefixLength = Number(prefix);
  if (!/^\d+$/u.test(prefix) || prefixLength > maxPrefix) {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR has an invalid prefix in "${entry}" (expected 1-${maxPrefix}). ${ALLOWED_CIDR_HINT}`,
    );
  }
  // A /0 matches every address, so it is an allow-all in allowlist clothing and
  // would silently defeat the guard the same way "*" does. Reject it and point
  // the operator at the real escape hatch (unset the variable).
  if (prefixLength === 0) {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR rejects the allow-all range "${entry}"; leave the variable unset for an unrestricted broker instead. ${ALLOWED_CIDR_HINT}`,
    );
  }
  const allowed = type === "ipv6" ? allowedIpv6 : allowedIpv4;
  allowed.addSubnet(address, prefixLength, type);
}

function addSingleAddress(
  allowedIpv4: BlockList,
  allowedIpv6: BlockList,
  entry: string,
): void {
  const type = addressType(entry, entry);
  const allowed = type === "ipv6" ? allowedIpv6 : allowedIpv4;
  allowed.addAddress(entry, type);
}

function addressType(address: string, entry: string): "ipv4" | "ipv6" {
  const family = isIP(address);
  if (family === 0) {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR has an invalid address in "${entry}". ${ALLOWED_CIDR_HINT}`,
    );
  }
  if (family === 6 && address.includes("%")) {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR does not support scoped IPv6 entries such as "${entry}"; configure an unscoped IPv6 CIDR instead. ${ALLOWED_CIDR_HINT}`,
    );
  }
  if (family === 6 && mappedIpv4Address(address) !== undefined) {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR does not support IPv4-mapped IPv6 entries such as "${entry}"; configure the equivalent IPv4 policy instead. ${ALLOWED_CIDR_HINT}`,
    );
  }
  return family === 6 ? "ipv6" : "ipv4";
}
