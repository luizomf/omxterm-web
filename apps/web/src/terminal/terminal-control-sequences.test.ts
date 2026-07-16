import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { registerTerminalControlSequenceHandlers } from './terminal-control-sequences';

const terminals: Terminal[] = [];

type TerminalWithOscLinkState = Terminal & {
  _core: {
    _oscLinkService: {
      _dataByLinkId: Map<number, unknown>;
    };
    _linkProviderService: {
      linkProviders: ILinkProvider[];
    };
  };
};

function createTerminal(): Terminal {
  const terminal = new Terminal({ scrollback: 2000 });
  terminals.push(terminal);
  return terminal;
}

function writeTerminal(terminal: Terminal, output: string): Promise<void> {
  return new Promise(resolve => terminal.write(output, resolve));
}

async function writeInChunks(
  terminal: Terminal,
  output: string,
  chunkSize: number,
): Promise<void> {
  for (let offset = 0; offset < output.length; offset += chunkSize) {
    await writeTerminal(terminal, output.slice(offset, offset + chunkSize));
  }
}

function retainedOsc8LinkCount(terminal: Terminal): number {
  // OSC 8 link state has no public inspection API. This pinned-xterm integration
  // assertion observes the exact service that retained attacker-sized URIs in
  // the browser reproduction from issue #146.
  return (terminal as TerminalWithOscLinkState)._core._oscLinkService
    ._dataByLinkId.size;
}

function provideLinks(
  terminal: Terminal,
  providerIndex: number,
): Promise<ILink[] | undefined> {
  const providers = (terminal as TerminalWithOscLinkState)._core
    ._linkProviderService.linkProviders;
  const provider = providers[providerIndex];
  if (!provider) {
    throw new Error(
      `Expected xterm link provider at index ${providerIndex}; found ${providers.length}.`,
    );
  }
  return new Promise(resolve => provider.provideLinks(1, resolve));
}

afterEach(() => {
  terminals.splice(0).forEach(terminal => terminal.dispose());
});

describe('registerTerminalControlSequenceHandlers', () => {
  test('does not retain a hostile OSC 8 URI split across terminal writes', async () => {
    const terminal = createTerminal();
    const registrations = registerTerminalControlSequenceHandlers(
      terminal,
      vi.fn(),
    );
    const hostileUri = `https://example.invalid/${'a'.repeat(256 * 1024)}`;
    const output = `\u001b]8;id=hostile;${hostileUri}\u001b\\linked text\u001b]8;;\u001b\\ recovered`;

    await writeInChunks(terminal, output, 997);

    expect(retainedOsc8LinkCount(terminal)).toBe(0);
    expect(
      terminal.buffer.active.getLine(0)?.translateToString(true),
    ).toBe('linked text recovered');
    registrations.dispose();
  });

  test.each([
    {
      terminator: 'BEL',
      open: '\u001b]8;id=ordinary:unused=value;https://example.invalid/docs\u0007',
      close: '\u001b]8;;\u0007',
    },
    {
      terminator: 'ESC \\',
      open: '\u001b]8;id=ordinary:unused=value;https://example.invalid/docs\u001b\\',
      close: '\u001b]8;;\u001b\\',
    },
    {
      terminator: 'C1 ST',
      open: '\u009d8;id=ordinary:unused=value;https://example.invalid/docs\u009c',
      close: '\u009d8;;\u009c',
    },
  ])(
    'consumes parameterized OSC 8 open and close sequences terminated by $terminator',
    async ({ open, close }) => {
      const terminal = createTerminal();
      registerTerminalControlSequenceHandlers(terminal, vi.fn());

      await writeInChunks(terminal, `${open}docs${close} recovered`, 1);

      expect(retainedOsc8LinkCount(terminal)).toBe(0);
      expect(
        terminal.buffer.active.getLine(0)?.translateToString(true),
      ).toBe('docs recovered');
    },
  );

  test('keeps incomplete OSC 8 state out of scrollback and recovers after termination', async () => {
    const terminal = createTerminal();
    registerTerminalControlSequenceHandlers(terminal, vi.fn());

    await writeInChunks(
      terminal,
      '\u001b]8;;https://example.invalid/incomplete',
      3,
    );

    expect(retainedOsc8LinkCount(terminal)).toBe(0);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('');

    await writeTerminal(
      terminal,
      '/completed\u001b\\visible\u001b]8;;\u001b\\ recovered',
    );

    expect(retainedOsc8LinkCount(terminal)).toBe(0);
    expect(
      terminal.buffer.active.getLine(0)?.translateToString(true),
    ).toBe('visible recovered');
  });

  test('keeps ordinary visible URLs detectable by WebLinksAddon', async () => {
    const terminal = createTerminal();
    terminal.loadAddon(new WebLinksAddon());
    registerTerminalControlSequenceHandlers(terminal, vi.fn());

    await writeTerminal(terminal, 'Docs: https://example.com/docs');

    // xterm installs its built-in OSC 8 provider first; WebLinksAddon is the
    // second provider in the same browser integration seam used in production.
    const links = await provideLinks(terminal, 1);
    expect(links?.map(link => link.text)).toEqual([
      'https://example.com/docs',
    ]);
  });

  test('preserves OSC 52 writes, read blocking, and the 64 KiB cap', async () => {
    const terminal = createTerminal();
    const writeClipboard = vi.fn();
    registerTerminalControlSequenceHandlers(terminal, writeClipboard);
    const boundaryPayload = btoa('a'.repeat(64 * 1024));
    const oversizedPayload = btoa('b'.repeat(64 * 1024 + 1));

    await writeInChunks(
      terminal,
      `\u001b]52;c;SGVsbG8=\u0007\u001b]52;c;?\u001b\\\u001b]52;c;${boundaryPayload}\u0007\u001b]52;c;${oversizedPayload}\u001b\\`,
      701,
    );

    expect(writeClipboard).toHaveBeenCalledTimes(2);
    expect(writeClipboard).toHaveBeenNthCalledWith(1, 'Hello');
    expect(writeClipboard).toHaveBeenNthCalledWith(
      2,
      'a'.repeat(64 * 1024),
    );
  });
});
