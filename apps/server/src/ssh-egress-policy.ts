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
// Validation resolves the host here, at the boundary, but does NOT pin the
// resolved IP into the connection: ssh2 re-resolves at connect time, so a
// hostname could in theory rebind in the window between this check and the dial.
// The terminal path is still partly protected because its host-key fingerprint
// is pinned (a rebound host presents a different key and is rejected by ssh.ts),
// and IP-literal targets have no window at all. The probe path is unpinned and
// has no fingerprint to compare, so pinning the resolved IP into both dials is
// tracked as a follow-up (#26). See ssh.ts hostVerifier and docs/how-it-works.md.

import { BlockList, isIP, isIPv6 } from "node:net";
import { lookup } from "node:dns/promises";

const ALLOWED_CIDR_HINT =
  "Set OMXTERM_SSH_ALLOWED_CIDR to a comma-separated list of IPv4/IPv6 CIDRs " +
  '(a bare address is treated as a single host), e.g. "10.100.0.0/24,10.0.0.5". ' +
  "Leave it unset to allow any target (single-user/localhost only). Wildcards are not allowed.";

export type SshEgressPolicy =
  | { readonly kind: "unrestricted" }
  | {
      readonly kind: "allowlist";
      readonly cidrs: readonly string[];
      readonly allowed: BlockList;
    };

export type ResolvedAddress = {
  readonly address: string;
  readonly family: number;
};

// Injected so the boundary check stays testable without real DNS.
export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

export type EgressDecision =
  | { readonly allowed: true; readonly addresses: readonly string[] }
  | { readonly allowed: false; readonly reason: string };

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
 * set. Each entry is an IPv4/IPv6 CIDR, or a bare address taken as a single host.
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

  const allowed = new BlockList();
  for (const entry of entries) {
    addCidrEntry(allowed, entry);
  }
  return { kind: "allowlist", cidrs: entries, allowed };
}

/**
 * Decide whether the broker may open an SSH connection to `host` under `policy`.
 *
 * `unrestricted` allows without resolving (preserving prior behavior). Otherwise
 * the host is resolved and every resolved address must fall inside the
 * allowlist; an empty/failed resolution or any out-of-list address is denied, so
 * a multi-record hostname cannot smuggle a blocked IP past the check.
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

  if (resolved.length === 0)
    return { allowed: false, reason: "resolution_empty" };

  for (const { address } of resolved) {
    if (isIP(address) === 0)
      return { allowed: false, reason: "invalid_resolved_address" };
    const type = isIPv6(address) ? "ipv6" : "ipv4";
    if (!policy.allowed.check(address, type)) {
      return { allowed: false, reason: "target_not_in_allowlist" };
    }
  }

  return { allowed: true, addresses: resolved.map((entry) => entry.address) };
}

function addCidrEntry(allowed: BlockList, entry: string): void {
  if (entry === "*") {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR does not allow the wildcard "*". ${ALLOWED_CIDR_HINT}`,
    );
  }

  const slashIndex = entry.indexOf("/");
  if (slashIndex === -1) {
    addSingleAddress(allowed, entry);
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
  allowed.addSubnet(address, prefixLength, type);
}

function addSingleAddress(allowed: BlockList, entry: string): void {
  allowed.addAddress(entry, addressType(entry, entry));
}

function addressType(address: string, entry: string): "ipv4" | "ipv6" {
  const family = isIP(address);
  if (family === 0) {
    throw new Error(
      `OMXTERM_SSH_ALLOWED_CIDR has an invalid address in "${entry}". ${ALLOWED_CIDR_HINT}`,
    );
  }
  return family === 6 ? "ipv6" : "ipv4";
}
