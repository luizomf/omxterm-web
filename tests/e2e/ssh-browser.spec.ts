import { expect, test, type WebSocket } from '@playwright/test';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function captureTerminalOutput(socket: WebSocket, chunks: string[]): void {
  socket.on('framereceived', frame => {
    if (typeof frame.payload !== 'string') return;
    try {
      const message = JSON.parse(frame.payload) as {
        type?: unknown;
        data?: unknown;
      };
      if (message.type === 'output' && typeof message.data === 'string') {
        chunks.push(message.data);
      }
    } catch {
      // Protocol parsing belongs to OMXTerm. The E2E only collects valid output
      // frames and ignores unrelated WebSocket traffic such as pong messages.
    }
  });
}

export function sentinelProtocol(): { command: string; output: string } {
  return {
    command: "printf 'OMXTERM_E2E_%s\\n' 'PTY_OK'",
    output: 'OMXTERM_E2E_PTY_OK',
  };
}

test('sentinel cannot pass from terminal command echo alone', () => {
  const sentinel = sentinelProtocol();
  expect(sentinel.command).not.toContain(sentinel.output);
  expect(`${sentinel.command}\r\n`).not.toContain(sentinel.output);
  expect(`${sentinel.command}\r\n${sentinel.output}\r\n`).toContain(
    sentinel.output,
  );
});

test('brokers a disposable SSH PTY and independently reopens both terminal bars', async ({
  page,
}) => {
  const origin = requiredEnvironment('OMXTERM_E2E_ORIGIN');
  const accessToken = requiredEnvironment('OMXTERM_E2E_ACCESS_TOKEN');
  const privateKeyPath = requiredEnvironment('OMXTERM_E2E_CLIENT_PRIVATE_KEY');
  const expectedFingerprint = requiredEnvironment(
    'OMXTERM_E2E_HOST_FINGERPRINT',
  );
  const fixtureAddress = requiredEnvironment('OMXTERM_E2E_SSH_ADDRESS');
  const sentinel = sentinelProtocol();
  const terminalOutput: string[] = [];

  page.on('websocket', socket => captureTerminalOutput(socket, terminalOutput));

  try {
    await page.goto(origin);
    await page.getByLabel('Access token').fill(accessToken);
    await page.getByRole('button', { name: 'Unlock OMXTerm' }).click();

    await page.getByLabel('Host').fill(fixtureAddress);
    await page.getByLabel('Port').fill('2222');
    await page.getByLabel('Username').fill('omxterm-e2e');
    await page.getByLabel('Load private key file').setInputFiles(privateKeyPath);
    await expect(page.locator('#private-key-input')).toHaveAttribute(
      'data-masked',
      'true',
    );
    await page
      .getByRole('button', { name: 'Continue to fingerprint' })
      .click();

    const fingerprint = page.locator('.fingerprint-box dd').last();
    await expect(fingerprint).toHaveText(expectedFingerprint);
    await page
      .getByRole('button', { name: 'Trust for this session' })
      .click();

    await expect(
      page.getByRole('region', { name: 'Terminal session' }),
    ).toBeVisible();
    const showToolbar = page.getByRole('button', { name: 'Show toolbar (+)' });
    const showKeyboardTools = page.getByRole('button', {
      name: 'Show keyboard tools (+)',
    });
    await expect(showToolbar).toBeVisible();
    await expect(showKeyboardTools).toBeVisible();
    await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('toolbar', { name: 'Terminal key shortcuts' }),
    ).toHaveCount(0);

    await showToolbar.click();
    await expect(
      page.getByRole('button', { name: 'End session' }),
    ).toBeVisible();
    await expect(showKeyboardTools).toBeVisible();
    await expect(page.locator('.status-connected')).toBeVisible();

    await showKeyboardTools.click();
    await expect(
      page.getByRole('toolbar', { name: 'Terminal key shortcuts' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'End session' }),
    ).toBeVisible();

    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(sentinel.command);
    await page.keyboard.press('Enter');
    await expect.poll(() => terminalOutput.join('')).toContain(sentinel.output);

    await page.getByRole('button', { name: 'End session' }).click();
    await expect(
      page.getByRole('heading', { name: 'Connect to a server' }),
    ).toBeVisible();
  } catch {
    // Playwright's automatic error context can serialize form values. Clear
    // React-controlled credential inputs before rethrowing a generic error so
    // neither reports nor failure output can retain generated secret material.
    await page.locator('#private-key-input').fill('').catch(() => {});
    await page.getByLabel('Access token').fill('').catch(() => {});
    throw new Error('Disposable SSH browser flow failed; credentials redacted.');
  }
});
