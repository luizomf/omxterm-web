import { describe, expect, test } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "./allowed-origins";

describe("parseAllowedOrigins", () => {
  test("parses a single origin into a one-entry list", () => {
    expect(parseAllowedOrigins("http://localhost:5173")).toEqual([
      "http://localhost:5173",
    ]);
  });

  test("parses a comma-separated list and trims whitespace", () => {
    expect(
      parseAllowedOrigins("http://localhost:5173, http://192.168.0.10:5173"),
    ).toEqual(["http://localhost:5173", "http://192.168.0.10:5173"]);
  });

  test("drops blank entries from stray commas", () => {
    expect(parseAllowedOrigins("http://localhost:5173,,")).toEqual([
      "http://localhost:5173",
    ]);
  });

  test("accepts https origins with a non-default port", () => {
    expect(parseAllowedOrigins("https://omxterm.example.com")).toEqual([
      "https://omxterm.example.com",
    ]);
  });

  test("throws when no origin remains after trimming", () => {
    expect(() => parseAllowedOrigins("   ,  ,")).toThrow(
      /OMXTERM_ALLOWED_ORIGIN/,
    );
  });

  test("rejects the wildcard so the allowlist cannot become open", () => {
    expect(() => parseAllowedOrigins("*")).toThrow(/wildcard/);
    expect(() => parseAllowedOrigins("http://localhost:5173,*")).toThrow(
      /wildcard/,
    );
  });

  test("rejects an origin missing a scheme", () => {
    expect(() => parseAllowedOrigins("localhost:5173")).toThrow(
      /invalid origin/,
    );
  });

  test("rejects an origin with a trailing slash or path", () => {
    expect(() => parseAllowedOrigins("http://localhost:5173/")).toThrow(
      /invalid origin/,
    );
    expect(() => parseAllowedOrigins("http://localhost:5173/app")).toThrow(
      /invalid origin/,
    );
  });

  test("rejects a non-http(s) scheme", () => {
    expect(() => parseAllowedOrigins("ftp://localhost:5173")).toThrow(
      /invalid origin/,
    );
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["http://localhost:5173", "http://192.168.0.10:5173"];

  test("accepts any origin present in the allowlist", () => {
    expect(isOriginAllowed("http://localhost:5173", allowed)).toBe(true);
    expect(isOriginAllowed("http://192.168.0.10:5173", allowed)).toBe(true);
  });

  test("rejects an origin outside the allowlist", () => {
    expect(isOriginAllowed("http://evil.example.com", allowed)).toBe(false);
  });

  test("rejects a missing origin", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });

  test("does not match on substrings or prefixes", () => {
    expect(isOriginAllowed("http://localhost:5173.evil.com", allowed)).toBe(
      false,
    );
    expect(isOriginAllowed("http://localhost:51730", allowed)).toBe(false);
  });
});
