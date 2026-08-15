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

  test.each(["fe80::1%eth0", "fe80::1%2", "fe80::%eth0/64"])(
    "rejects the scoped IPv6 policy entry %s instead of discarding its scope",
    (entry) => {
      expect(() => parseSshEgressAllowlist(entry)).toThrow(/scoped IPv6/);
    },
  );

  test.each([
    "::ffff:192.0.2.1",
    "::ffff:c000:200/120",
    "0:0:0:0:0:ffff:c000:0200/120",
  ])(
    "rejects the mapped IPv6 policy entry %s and directs operators to IPv4 policy",
    (entry) => {
      expect(() => parseSshEgressAllowlist(entry)).toThrow(/IPv4 policy/);
    },
  );

  test("keeps an ordinary IPv6 neighbor of mapped space as IPv6 policy", () => {
    expect(parseSshEgressAllowlist("::ffff:0:c000:201").kind).toBe(
      "allowlist",
    );
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
    let resolverCalls = 0;
    const resolve: HostResolver = async () => {
      resolverCalls += 1;
      throw new Error("The unrestricted resolver must not run.");
    };

    const decision = await checkSshEgress(
      "anything",
      { kind: "unrestricted" },
      resolve,
    );

    expect(decision).toEqual({ allowed: true, addresses: [] });
    expect(resolverCalls).toBe(0);
  });

  test("allows a target that resolves inside the allowlist", async () => {
    const resolve = resolverFor({ "private-host.example": ["10.100.0.4"] });
    const decision = await checkSshEgress(
      "private-host.example",
      vpnPolicy,
      resolve,
    );
    expect(decision).toEqual({ allowed: true, addresses: ["10.100.0.4"] });
  });

  test("allows an IP literal inside the allowlist", async () => {
    const resolve = resolverFor({ "10.100.0.8": ["10.100.0.8"] });
    const decision = await checkSshEgress("10.100.0.8", vpnPolicy, resolve);
    expect(decision.allowed).toBe(true);
  });

  test.each([
    "::ffff:192.0.2.1",
    "::ffff:c000:201",
    "0:0:0:0:0:ffff:c000:0201",
  ])(
    "normalizes the mapped IPv6 resolver form %s to canonical IPv4",
    async (address) => {
      const policy = parseSshEgressAllowlist("192.0.2.0/24");
      const decision = await checkSshEgress(
        "mapped.example",
        policy,
        resolverFor({ "mapped.example": [address] }),
      );

      expect(decision).toEqual({ allowed: true, addresses: ["192.0.2.1"] });
    },
  );

  test("allows a mapped result through an exact IPv4 bare-host policy", async () => {
    const policy = parseSshEgressAllowlist("192.0.2.1");
    const resolve: HostResolver = async () => [
      { address: "::ffff:c000:201", family: 6 },
    ];

    await expect(
      checkSshEgress("mapped.example", policy, resolve),
    ).resolves.toEqual({
      allowed: true,
      addresses: ["192.0.2.1"],
    });
  });

  test("does not authorize a mapped result through an IPv6-only policy", async () => {
    const policy = parseSshEgressAllowlist("::/1");
    const resolve: HostResolver = async () => [
      { address: "::ffff:c000:201", family: 6 },
    ];

    await expect(
      checkSshEgress("mapped.example", policy, resolve),
    ).resolves.toEqual({
      allowed: false,
      reason: "target_not_in_allowlist",
    });
  });

  test("requires mapped IPv6 resolver metadata to be family 6 before normalization", async () => {
    const policy = parseSshEgressAllowlist("192.0.2.0/24");
    const resolve: HostResolver = async () => [
      { address: "::ffff:192.0.2.1", family: 4 },
    ];

    await expect(
      checkSshEgress("mapped.example", policy, resolve),
    ).resolves.toEqual({
      allowed: false,
      reason: "resolved_address_family_mismatch",
    });
  });

  test.each([
    { address: "192.0.2.1", family: 6 },
    { address: "2001:db8::1", family: 4 },
  ])(
    "rejects resolver family $family for textual address $address",
    async ({ address, family }) => {
      const policy = parseSshEgressAllowlist("192.0.2.0/24,2001:db8::/32");
      const resolve: HostResolver = async () => [{ address, family }];

      await expect(
        checkSshEgress("mismatch.example", policy, resolve),
      ).resolves.toEqual({
        allowed: false,
        reason: "resolved_address_family_mismatch",
      });
    },
  );

  test.each([0, 5, Number.NaN, "4", undefined])(
    "rejects invalid resolver family metadata %s with a normalized reason",
    async (family) => {
      const resolve: HostResolver = async () =>
        [{ address: "10.100.0.4", family }] as unknown as ResolvedAddress[];

      await expect(
        checkSshEgress("invalid-family.example", vpnPolicy, resolve),
      ).resolves.toEqual({
        allowed: false,
        reason: "invalid_resolved_address_family",
      });
    },
  );

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

  test("requires every result to pass after mapped normalization", async () => {
    const policy = parseSshEgressAllowlist("192.0.2.0/24");
    const resolve: HostResolver = async () => [
      { address: "::ffff:c000:201", family: 6 },
      { address: "198.51.100.1", family: 4 },
    ];

    await expect(
      checkSshEgress("multi.example", policy, resolve),
    ).resolves.toEqual({
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

  test.each([
    { scopeKind: "named", address: "fe80::1%eth0" },
    { scopeKind: "numeric", address: "fe80::1%2" },
    { scopeKind: "different named", address: "fe80::1%eth1" },
  ])(
    "rejects a $scopeKind scoped IPv6 resolver result without dropping or cross-matching its scope",
    async ({ address }) => {
      const policy = parseSshEgressAllowlist("fe80::/10");
      const resolve: HostResolver = async () => [{ address, family: 6 }];

      await expect(
        checkSshEgress("link-local.example", policy, resolve),
      ).resolves.toEqual({
        allowed: false,
        reason: "scoped_resolved_address",
      });
    },
  );

  test("keeps a non-mapped IPv6 address beside mapped space in IPv6", async () => {
    const policy = parseSshEgressAllowlist("::/1");
    const resolve: HostResolver = async () => [
      { address: "::ffff:0:192.0.2.1", family: 6 },
    ];

    await expect(
      checkSshEgress("ordinary-v6.example", policy, resolve),
    ).resolves.toEqual({
      allowed: true,
      addresses: ["::ffff:0:c000:201"],
    });
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

  test("canonicalizes ordinary IPv6 and IPv4 while preserving resolver order and first selection", async () => {
    const policy = parseSshEgressAllowlist("2001:db8::/32,192.0.2.0/24");
    const resolve: HostResolver = async () => [
      { address: "2001:0DB8:0:0:0:0:0:1", family: 6 },
      { address: "192.0.2.9", family: 4 },
    ];

    const decision = await checkSshEgress("ordered.example", policy, resolve);

    expect(decision).toEqual({
      allowed: true,
      addresses: ["2001:db8::1", "192.0.2.9"],
    });
    if (decision.allowed) expect(decision.addresses[0]).toBe("2001:db8::1");
  });

  test("rejects a non-array resolver response at runtime", async () => {
    const resolve: HostResolver = async () =>
      ({ address: "10.100.0.4", family: 4 }) as unknown as ResolvedAddress[];

    await expect(
      checkSshEgress("invalid-result.example", vpnPolicy, resolve),
    ).resolves.toEqual({
      allowed: false,
      reason: "invalid_resolver_result",
    });
  });

  test.each([null, { address: 123, family: 4 }])(
    "rejects the malformed resolver entry %j at runtime",
    async (entry) => {
      const resolve: HostResolver = async () =>
        [entry] as unknown as ResolvedAddress[];

      await expect(
        checkSshEgress("invalid-entry.example", vpnPolicy, resolve),
      ).resolves.toEqual({
        allowed: false,
        reason: "invalid_resolver_result",
      });
    },
  );

  test("rejects an invalid textual resolver address with a normalized reason", async () => {
    const resolve: HostResolver = async () => [
      { address: "not-an-ip", family: 4 },
    ];

    await expect(
      checkSshEgress("invalid-address.example", vpnPolicy, resolve),
    ).resolves.toEqual({
      allowed: false,
      reason: "invalid_resolved_address",
    });
  });

  test("denies when the host does not resolve to any address", async () => {
    const decision = await checkSshEgress("ghost", vpnPolicy, resolverFor({}));
    expect(decision).toEqual({ allowed: false, reason: "resolution_empty" });
  });

  test("denies when resolution fails instead of leaking the error", async () => {
    const decision = await checkSshEgress("broken", vpnPolicy, failingResolver);
    expect(decision).toEqual({ allowed: false, reason: "resolution_failed" });
  });

  test("surfaces the IP validated at check time so a later DNS rebind cannot move the pinned dial (#26)", async () => {
    // DNS TOCTOU: the host resolves to an allowlisted IP when checked, then
    // rebinds to a blocked metadata address. The decision must reflect the
    // check-time resolution — that captured IP is what the caller pins into the
    // dial, so a rebind between check and connect changes nothing.
    let calls = 0;
    const rebinding: HostResolver = async () => {
      calls += 1;
      const address = calls === 1 ? "10.100.0.4" : "169.254.169.254";
      return [{ address, family: 4 }];
    };
    const decision = await checkSshEgress("rebind.evil", vpnPolicy, rebinding);
    expect(decision).toEqual({ allowed: true, addresses: ["10.100.0.4"] });
  });
});
