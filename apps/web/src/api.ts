export type SshConnectionDraft = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String(data.message)
        : 'Request failed.';
    throw new Error(message);
  }
  return data as T;
}

export async function checkAuth(): Promise<boolean> {
  const response = await fetch('/api/me', { credentials: 'same-origin' });
  if (!response.ok) return false;
  const data = (await response.json()) as { authenticated: boolean };
  return data.authenticated;
}

export async function submitAccessToken(accessToken: string): Promise<void> {
  await postJson('/api/access', { accessToken });
}

export async function probeHostKey(target: {
  host: string;
  port: number;
}): Promise<string> {
  const data = await postJson<{ ok: true; fingerprint: string }>(
    '/api/ssh/host-key',
    target,
  );
  return data.fingerprint;
}

export async function createTerminalTicket(
  profile: SshConnectionDraft & { acceptedHostFingerprint: string },
): Promise<{ ticket: string; wsUrl: string }> {
  const data = await postJson<{ ok: true; ticket: string; wsUrl: string }>(
    '/api/terminal-ticket',
    profile,
  );
  return { ticket: data.ticket, wsUrl: data.wsUrl };
}

export function buildWebSocketUrl(wsUrl: string, ticket: string): string {
  const url = new URL(wsUrl, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}
