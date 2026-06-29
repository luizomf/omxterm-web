import { describe, expect, test } from "vitest";
import {
  DEVICE_TOKEN_COOKIE,
  SESSION_ID_COOKIE,
  SESSION_TOKEN_COOKIE,
  parseCookieHeader,
} from "./cookies";

describe("parseCookieHeader", () => {
  test("returns an empty object when no header is present", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  test("parses multiple cookies and decodes percent-encoded values", () => {
    expect(parseCookieHeader("a=1; b=hello%20world")).toEqual({
      a: "1",
      b: "hello world",
    });
  });

  test("reads the auth cookies set by the broker", () => {
    const header = `${SESSION_ID_COOKIE}=sid; ${SESSION_TOKEN_COOKIE}=stok; ${DEVICE_TOKEN_COOKIE}=dtok`;
    expect(parseCookieHeader(header)).toMatchObject({
      [SESSION_ID_COOKIE]: "sid",
      [SESSION_TOKEN_COOKIE]: "stok",
      [DEVICE_TOKEN_COOKIE]: "dtok",
    });
  });

  test("treats a segment without '=' as a name with an empty value", () => {
    expect(parseCookieHeader("flag; a=1")).toEqual({ flag: "", a: "1" });
  });

  // Regression for #28: this parser runs in the raw "upgrade" listener with no
  // try/catch, so a thrown URIError would crash the process (DoS).
  test("does not throw on malformed percent-encoding", () => {
    expect(() => parseCookieHeader("a=%E0%A4%A")).not.toThrow();
  });

  test("drops a malformed pair instead of propagating the error", () => {
    expect(parseCookieHeader("a=%E0%A4%A")).toEqual({});
  });

  test("keeps valid cookies when another pair is malformed", () => {
    const header = `${SESSION_ID_COOKIE}=sid; bad=%E0%A4%A; ${SESSION_TOKEN_COOKIE}=stok`;
    expect(parseCookieHeader(header)).toEqual({
      [SESSION_ID_COOKIE]: "sid",
      [SESSION_TOKEN_COOKIE]: "stok",
    });
  });

  test("drops a pair whose name is malformed", () => {
    expect(parseCookieHeader("%E0%A4%A=value")).toEqual({});
  });
});
