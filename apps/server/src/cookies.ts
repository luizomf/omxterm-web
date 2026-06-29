import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_ID_COOKIE = 'omxterm_session_id';
export const SESSION_TOKEN_COOKIE = 'omxterm_session_token';
export const DEVICE_TOKEN_COOKIE = 'omxterm_device_token';

type CookieOptions = {
  secure: boolean;
};

export function setAuthCookies(reply: FastifyReply, values: { sessionId: string; sessionToken: string; deviceToken: string }, options: CookieOptions): void {
  const common = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: options.secure,
    path: '/',
  };
  reply.setCookie(SESSION_ID_COOKIE, values.sessionId, common);
  reply.setCookie(SESSION_TOKEN_COOKIE, values.sessionToken, common);
  reply.setCookie(DEVICE_TOKEN_COOKIE, values.deviceToken, common);
}

export function readAuthCookies(request: FastifyRequest): { sessionId: string | undefined; sessionToken: string | undefined; deviceToken: string | undefined } {
  return {
    sessionId: request.cookies[SESSION_ID_COOKIE],
    sessionToken: request.cookies[SESSION_TOKEN_COOKIE],
    deviceToken: request.cookies[DEVICE_TOKEN_COOKIE],
  };
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part): [string, string][] => {
        const index = part.indexOf('=');
        if (index === -1) return [[part, '']];
        // A malformed percent-encoding (e.g. "%E0%A4%A") makes decodeURIComponent
        // throw URIError. This parser runs in the raw "upgrade" listener, which has
        // no try/catch, so propagating would crash the process (DoS, #28). Skip the
        // malformed pair instead and let auth validation reject the upgrade.
        const name = safeDecodeCookieComponent(part.slice(0, index));
        const value = safeDecodeCookieComponent(part.slice(index + 1));
        if (name === null || value === null) return [];
        return [[name, value]];
      }),
  );
}

function safeDecodeCookieComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
