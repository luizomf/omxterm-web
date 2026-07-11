import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSshBrokerFlow } from './App';

// Placeholder, obviously-fake credentials. Never assert on their values or let
// them reach test output: the point of #81 is not leaking real ones (see the
// `pendingHostKey === null` boolean assertions below, which never dump the
// profile object even when they fail).
const sshTarget = {
  host: 'server.example',
  port: 22,
  username: 'demo',
  privateKey: 'fake-private-key-fixture',
  passphrase: 'fake-passphrase-fixture',
};

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    checkAuth: vi.fn(async () => true),
    submitAccessToken: vi.fn(async () => undefined),
    probeHostKey: vi.fn(async () => 'SHA256:fingerprint-placeholder'),
    createTerminalTicket: vi.fn(async () => ({
      ticket: 'ticket-placeholder',
      wsUrl: '/terminal/ws',
    })),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function reachHostKeyConfirmation() {
  const view = renderHook(() => useSshBrokerFlow());
  await waitFor(() => expect(view.result.current.step).toBe('connect'));
  await act(async () => {
    await view.result.current.handleConnect(sshTarget);
  });
  expect(view.result.current.step).toBe('host-key');
  // Retained on purpose while the confirmation screen is showing.
  expect(view.result.current.pendingHostKey !== null).toBe(true);
  return view;
}

describe('useSshBrokerFlow credential lifetime', () => {
  test('drops the pending SSH profile when leaving host-key confirmation via Back', async () => {
    const { result } = await reachHostKeyConfirmation();

    act(() => {
      result.current.leaveHostKeyConfirmation();
    });

    expect(result.current.step).toBe('connect');
    expect(result.current.pendingHostKey === null).toBe(true);
  });

  test('keeps clearing the pending SSH profile after a successful ticket (#30)', async () => {
    const { result } = await reachHostKeyConfirmation();

    await act(async () => {
      await result.current.handleTrustHostKey();
    });

    expect(result.current.step).toBe('terminal');
    expect(result.current.pendingHostKey === null).toBe(true);
  });

  test('retains the pending SSH profile when ticket issuance fails so the user can retry on the same screen', async () => {
    const { createTerminalTicket } = await import('../api');
    vi.mocked(createTerminalTicket).mockRejectedValueOnce(
      new Error('ticket rejected'),
    );

    const { result } = await reachHostKeyConfirmation();

    await act(async () => {
      await result.current.handleTrustHostKey();
    });

    expect(result.current.step).toBe('host-key');
    expect(result.current.error).toBeTruthy();
    expect(result.current.pendingHostKey !== null).toBe(true);
  });
});
