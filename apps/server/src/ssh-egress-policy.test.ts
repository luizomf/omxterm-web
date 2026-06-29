import { describe, expect, test } from "vitest";
import {
  checkSshEgress,
  parseSshEgressAllowlist,
  type HostResolver,
  type ResolvedAddress,
} from "./ssh-egress-policy";

// Named fakes so the egress check runs without touching real DNS.
function resolverFor(addresses: Record<string, string[]>): HostResolver {
  return async (host) => {
    const found = addresses[host] ?? [];
    return found.map<ResolvedAddress>((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
}

const failingResolver: HostResolver = async () => {
  throw new Error("DNS lookup failed");
};

describe("parseSshEgressAllowlist", () => {
  test("treats an unset value as unrestricted so the localhost demo still works", () => {
    expect(parseSshEgressAllowlist(undefined)).toEqual({
      kind: "unrestricted",
    });
  });

  test("treats blank and comma-only values as unrestricted", () => {
    expect(parseSshEgressAllowlist("   ")).toEqual({ kind: "unrestricted" });
    expect(parseSshEgressAllowlist(" , ,")).toEqual({ kind: "unrestricted" });
  });

  test("parses a CIDR list, trimming whitespace and keeping the source entries", () => {
    const policy = parseSshEgressAllowlist("10.100.0.0/24, 10.0.0.5");
    expect(policy.kind).toBe("allowlist");
    if (policy.kind !== "allowlist") return;
    expect(policy.cidrs).toEqual(["10.100.0.0/24", "10.0.0.5"]);
  });

  test("accepts IPv6 CIDRs and bare addresses", () => {
    expect(parseSshEgressAllowlist("fd10:100::/64").kind).toBe("allowlist");
    expect(parseSshEgressAllowlist("::1").kind).toBe("allowlist");
  });

  test("rejects the wildcard so the allowlist cannot become open", () => {
    expect(() => parseSshEgressAllowlist("*")).toThrow(/wildcard/);
    expect(() => parseSshEgressAllowlist("10.100.0.0/24,*")).toThrow(
      /wildcard/,
    );
  });

  test("rejects an allow-all /0 range that would defeat the allowlist", () => {
    expect(() => parseSshEgressAllowlist("0.0.0.0/0")).toThrow(/allow-all/);
    expect(() => parseSshEgressAllowlist("::/0")).toThrow(/allow-all/);
  });

  test("rejects a malformed address", () => {
    expect(() => parseSshEgressAllowlist("not-an-ip/24")).toThrow(
      /invalid address/,
    );
    expect(() => parseSshEgressAllowlist("example.com")).toThrow(
      /invalid address/,
    );
  });

  test("rejects an out-of-range or missing prefix", () => {
    expect(() => parseSshEgressAllowlist("10.0.0.0/99")).toThrow(
      /invalid prefix/,
    );
    expect(() => parseSshEgressAllowlist("10.0.0.0/")).toThrow(
      /invalid prefix/,
    );
    expect(() => parseSshEgressAllowlist("fd10:100::/200")).toThrow(
      /invalid prefix/,
    );
  });
});

describe("checkSshEgress", () => {
  const vpnPolicy = parseSshEgressAllowlist("10.100.0.0/24");

  test("allows any target when the policy is unrestricted, without resolving", async () => {
    const decision = await checkSshEgress(
      "anything",
      { kind: "unrestricted" },
      failingResolver,
    );
    expect(decision.allowed).toBe(true);
  });

  test("allows a target that resolves inside the allowlist", async () => {
    const resolve = resolverFor({ "kvm4.vpn": ["10.100.0.4"] });
    const decision = await checkSshEgress("kvm4.vpn", vpnPolicy, resolve);
    expect(decision).toEqual({ allowed: true, addresses: ["10.100.0.4"] });
  });

  test("allows an IP literal inside the allowlist", async () => {
    const resolve = resolverFor({ "10.100.0.8": ["10.100.0.8"] });
    const decision = await checkSshEgress("10.100.0.8", vpnPolicy, resolve);
    expect(decision.allowed).toBe(true);
  });

  test("blocks loopback when it is not in the allowlist", async () => {
    const resolve = resolverFor({ "localhost.evil": ["127.0.0.1"] });
    const decision = await checkSshEgress("localhost.evil", vpnPolicy, resolve);
    expect(decision).toEqual({
      allowed: false,
      reason: "target_not_in_allowlist",
    });
  });

  test("blocks the cloud metadata address when it is not in the allowlist", async () => {
    const resolve = resolverFor({ rebind: ["169.254.169.254"] });
    const decision = await checkSshEgress("rebind", vpnPolicy, resolve);
    expect(decision.allowed).toBe(false);
  });

  test("blocks when any resolved address falls outside the allowlist", async () => {
    const resolve = resolverFor({
      "multi.evil": ["10.100.0.4", "169.254.169.254"],
    });
    const decision = await checkSshEgress("multi.evil", vpnPolicy, resolve);
    expect(decision).toEqual({
      allowed: false,
      reason: "target_not_in_allowlist",
    });
  });

  test("allows loopback once it is explicitly added to the allowlist", async () => {
    const policy = parseSshEgressAllowlist("127.0.0.0/8, 10.100.0.0/24");
    const resolve = resolverFor({ local: ["127.0.0.1"] });
    const decision = await checkSshEgress("local", policy, resolve);
    expect(decision.allowed).toBe(true);
  });

  test("matches IPv6 targets against an IPv6 allowlist", async () => {
    const policy = parseSshEgressAllowlist("fd10:100::/64");
    const inside = resolverFor({ host6: ["fd10:100::2"] });
    const outside = resolverFor({ host6: ["fd00:dead::1"] });
    expect((await checkSshEgress("host6", policy, inside)).allowed).toBe(true);
    expect((await checkSshEgress("host6", policy, outside)).allowed).toBe(
      false,
    );
  });

  test("denies when the host does not resolve to any address", async () => {
    const decision = await checkSshEgress("ghost", vpnPolicy, resolverFor({}));
    expect(decision).toEqual({ allowed: false, reason: "resolution_empty" });
  });

  test("denies when resolution fails instead of leaking the error", async () => {
    const decision = await checkSshEgress("broken", vpnPolicy, failingResolver);
    expect(decision).toEqual({ allowed: false, reason: "resolution_failed" });
  });
});
