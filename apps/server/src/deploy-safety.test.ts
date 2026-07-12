import { describe, expect, test } from "vitest";
import {
  assertSafeCookieDeployment,
  isLoopbackHost,
  parseTrustProxy,
} from "./deploy-safety";

describe("parseTrustProxy", () => {
  test("defaults to false when unset or blank", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
  });

  test("reads booleans case-insensitively and trimmed", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("  TRUE  ")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });

  test("reads a non-negative integer as a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("0")).toBe(0);
  });

  test("passes an IP/CIDR allowlist through as a string", () => {
    expect(parseTrustProxy("10.100.0.1")).toBe("10.100.0.1");
    expect(parseTrustProxy("127.0.0.1,10.100.0.0/24")).toBe(
      "127.0.0.1,10.100.0.0/24",
    );
    expect(parseTrustProxy("-1")).toBe("-1");
  });
});

describe("isLoopbackHost", () => {
  test("treats localhost and the loopback range as loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.5.5")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("  LOCALHOST  ")).toBe(true);
  });

  test("treats all-interfaces, LAN, and public binds as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.100.0.2")).toBe(false);
    expect(isLoopbackHost("192.168.0.10")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("127.example.com")).toBe(false);
  });
});

describe("assertSafeCookieDeployment", () => {
  test("allows loopback binds without secure cookies", () => {
    expect(() =>
      assertSafeCookieDeployment({ host: "127.0.0.1", secureCookies: false }),
    ).not.toThrow();
  });

  test("allows non-loopback binds when secure cookies are on", () => {
    expect(() =>
      assertSafeCookieDeployment({ host: "0.0.0.0", secureCookies: true }),
    ).not.toThrow();
  });

  test("refuses a non-loopback bind with secure cookies off", () => {
    expect(() =>
      assertSafeCookieDeployment({ host: "0.0.0.0", secureCookies: false }),
    ).toThrow(/OMXTERM_SECURE_COOKIES/);
  });
});
