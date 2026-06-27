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
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}
