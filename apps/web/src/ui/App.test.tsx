import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App, useSshBrokerFlow } from './App';

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

describe('ConnectionGate private key masking (#94)', () => {
  // checkAuth mock resolves authenticated, so <App /> lands on the connect form.
  async function renderConnectionForm() {
    render(<App />);
    return (await screen.findByLabelText('Private key')) as HTMLTextAreaElement;
  }

  test('masks the private key field by default and offers a reveal control', async () => {
    const privateKeyField = await renderConnectionForm();

    expect(privateKeyField).toHaveAttribute('data-masked', 'true');
    expect(
      screen.getByRole('button', { name: /show private key/i }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('reveals and re-hides the private key through the toggle control', async () => {
    const privateKeyField = await renderConnectionForm();

    fireEvent.click(screen.getByRole('button', { name: /show private key/i }));
    expect(privateKeyField).toHaveAttribute('data-masked', 'false');
    const hideControl = screen.getByRole('button', {
      name: /hide private key/i,
    });
    expect(hideControl).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(hideControl);
    expect(privateKeyField).toHaveAttribute('data-masked', 'true');
    expect(
      screen.getByRole('button', { name: /show private key/i }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('preserves multiline key content when toggling the reveal control', async () => {
    const privateKeyField = await renderConnectionForm();
    // Obviously-fake multiline fixture; never a real key (mirrors the #81 note).
    const fakeMultilineKey =
      '-----BEGIN FAKE KEY-----\nline-two-placeholder\n-----END FAKE KEY-----';

    fireEvent.change(privateKeyField, { target: { value: fakeMultilineKey } });
    fireEvent.click(screen.getByRole('button', { name: /show private key/i }));
    fireEvent.click(screen.getByRole('button', { name: /hide private key/i }));

    expect(privateKeyField).toHaveValue(fakeMultilineKey);
  });

  test('keeps a private key loaded from a file masked by default', async () => {
    const privateKeyField = await renderConnectionForm();
    const fakeFileKey =
      '-----BEGIN FAKE KEY-----\nfrom-file-placeholder\n-----END FAKE KEY-----';
    const keyFile = new File([fakeFileKey], 'id_ed25519', {
      type: 'text/plain',
    });

    const fileInput = screen.getByLabelText('Load private key file');
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [keyFile] } });
    });

    await waitFor(() => expect(privateKeyField).toHaveValue(fakeFileKey));
    expect(privateKeyField).toHaveAttribute('data-masked', 'true');
  });

  test('re-masks a file-loaded key even after the field was revealed', async () => {
    const privateKeyField = await renderConnectionForm();
    const fakeFileKey =
      '-----BEGIN FAKE KEY-----\nreloaded-placeholder\n-----END FAKE KEY-----';
    const keyFile = new File([fakeFileKey], 'id_ed25519', {
      type: 'text/plain',
    });

    // Reveal first, then load a new file: the fresh key must not inherit the
    // prior reveal and leak in plaintext.
    fireEvent.click(screen.getByRole('button', { name: /show private key/i }));
    expect(privateKeyField).toHaveAttribute('data-masked', 'false');

    const fileInput = screen.getByLabelText('Load private key file');
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [keyFile] } });
    });

    await waitFor(() => expect(privateKeyField).toHaveValue(fakeFileKey));
    expect(privateKeyField).toHaveAttribute('data-masked', 'true');
    expect(
      screen.getByRole('button', { name: /show private key/i }),
    ).toHaveAttribute('aria-pressed', 'false');
  });
});
