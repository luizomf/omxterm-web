import { useEffect, useState } from 'react';
import {
  buildWebSocketUrl,
  checkAuth,
  createTerminalTicket,
  probeHostKey,
  submitAccessToken,
  type SshConnectionDraft,
} from '../api';
import { TerminalEmulator } from '../terminal/TerminalEmulator';
import { WebSocketTerminalTransport } from '../terminal/WebSocketTerminalTransport';

type Step = 'loading' | 'access' | 'connect' | 'host-key' | 'terminal';

type PendingHostKey = {
  profile: SshConnectionDraft;
  fingerprint: string;
};

// Owns the broker flow state machine (access -> connect -> host-key -> terminal)
// so the credential lifetime across each transition is testable at a public
// seam instead of only through the rendered tree (#81).
export function useSshBrokerFlow() {
  const [step, setStep] = useState<Step>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pendingHostKey, setPendingHostKey] = useState<PendingHostKey | null>(
    null,
  );
  const [transport, setTransport] = useState<WebSocketTerminalTransport | null>(
    null,
  );
  const [terminalTitle, setTerminalTitle] = useState('terminal');

  useEffect(() => {
    void checkAuth().then(authenticated =>
      setStep(authenticated ? 'connect' : 'access'),
    );
  }, []);

  async function handleAccess(accessToken: string) {
    setError(null);
    try {
      await submitAccessToken(accessToken);
      setStep('connect');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Access failed.');
    }
  }

  async function handleConnect(profile: SshConnectionDraft) {
    setError(null);
    try {
      const fingerprint = await probeHostKey({
        host: profile.host,
        port: profile.port,
      });
      setPendingHostKey({ profile, fingerprint });
      setStep('host-key');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not read SSH host key.',
      );
    }
  }

  async function handleTrustHostKey() {
    if (!pendingHostKey) return;
    setError(null);
    const { profile, fingerprint } = pendingHostKey;
    try {
      const ticket = await createTerminalTicket({
        ...profile,
        acceptedHostFingerprint: fingerprint,
      });
      setTerminalTitle(`${profile.username}@${profile.host}`);
      setTransport(
        new WebSocketTerminalTransport(
          buildWebSocketUrl(ticket.wsUrl, ticket.ticket),
        ),
      );
      // Drop the private key/passphrase from React state once the ticket exists;
      // the browser no longer needs them for the WS session, so they shouldn't
      // stay mounted for the whole terminal session (#30, finding 9).
      setPendingHostKey(null);
      setStep('terminal');
    } catch (caught) {
      // Keep the pending profile so the user can retry trusting on the same
      // confirmation screen; it is dropped as soon as they leave (#81).
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not create terminal ticket.',
      );
    }
  }

  function leaveHostKeyConfirmation() {
    // Back abandons the confirmation, so drop the private key/passphrase
    // reference before returning to the form instead of leaving it mounted
    // until the next connection overwrites it (#81). JS strings can't be
    // securely wiped in V8, but releasing the reference lets it be reclaimed.
    setPendingHostKey(null);
    setStep('connect');
  }

  function returnToConnectForm() {
    setStep('connect');
  }

  return {
    step,
    error,
    pendingHostKey,
    transport,
    terminalTitle,
    handleAccess,
    handleConnect,
    handleTrustHostKey,
    leaveHostKeyConfirmation,
    returnToConnectForm,
  };
}

export function App() {
  const flow = useSshBrokerFlow();

  return (
    <main
      className={
        flow.step === 'terminal' ? 'app-shell app-shell--terminal' : 'app-shell'
      }
    >
      {flow.step !== 'terminal' ? <MarketingChrome /> : null}
      {flow.error ? (
        <div className='global-error' role='alert'>
          {flow.error}
        </div>
      ) : null}
      {flow.step === 'loading' ? <p className='loading'>Loading…</p> : null}
      {flow.step === 'access' ? (
        <AccessGate onSubmit={flow.handleAccess} />
      ) : null}
      {flow.step === 'connect' ? (
        <ConnectionGate onSubmit={flow.handleConnect} />
      ) : null}
      {flow.step === 'host-key' && flow.pendingHostKey ? (
        <HostKeyGate
          pending={flow.pendingHostKey}
          onBack={flow.leaveHostKeyConfirmation}
          onTrust={flow.handleTrustHostKey}
        />
      ) : null}
      {flow.step === 'terminal' && flow.transport ? (
        <TerminalEmulator
          adapter={flow.transport}
          title={flow.terminalTitle}
          onDisconnect={flow.returnToConnectForm}
        />
      ) : null}
    </main>
  );
}

function MarketingChrome() {
  return (
    <section className='hero-copy' aria-label='OMXTerm intro'>
      <p className='eyebrow'>Browser SSH terminal</p>
      <h1>OMXTerm</h1>
      <p>
        A weekend build that still checks your host key before letting you in.
      </p>
    </section>
  );
}

function AccessGate({ onSubmit }: { onSubmit(accessToken: string): void }) {
  const [accessToken, setAccessToken] = useState('');
  return (
    <form
      className='glass-card narrow-card'
      onSubmit={event => {
        event.preventDefault();
        onSubmit(accessToken);
      }}
    >
      <p className='eyebrow'>Private preview</p>
      <h2>Enter access token</h2>
      <label>
        <span>Access token</span>
        <input
          value={accessToken}
          onChange={event => setAccessToken(event.target.value)}
          type='password'
          autoFocus
        />
      </label>
      <button type='submit'>Unlock OMXTerm</button>
    </form>
  );
}

function ConnectionGate({
  onSubmit,
}: {
  onSubmit(profile: SshConnectionDraft): void;
}) {
  const [profile, setProfile] = useState<SshConnectionDraft>({
    host: '',
    port: 22,
    username: '',
    privateKey: '',
  });
  // Shoulder-surfing protection: the key is masked until the user opts in,
  // including keys loaded from a file (the default stays masked) (#94).
  const [privateKeyRevealed, setPrivateKeyRevealed] = useState(false);
  const setField = <K extends keyof SshConnectionDraft>(
    key: K,
    value: SshConnectionDraft[K],
  ) => setProfile(current => ({ ...current, [key]: value }));

  async function readKeyFile(file: File | undefined) {
    if (!file) return;
    setField('privateKey', await file.text());
    // A freshly loaded key must never inherit a prior reveal; re-mask so
    // file-loaded keys stay hidden by default even if the field was shown (#94).
    setPrivateKeyRevealed(false);
  }

  return (
    <form
      className='glass-card connection-card'
      onSubmit={event => {
        event.preventDefault();
        onSubmit(profile);
      }}
    >
      <div className='card-heading'>
        <p className='eyebrow'>SSH target</p>
        <h2>Connect to a server</h2>
      </div>
      <div className='field-grid'>
        <label>
          <span>Host</span>
          <input
            value={profile.host}
            onChange={event => setField('host', event.target.value)}
            placeholder='example.com'
            required
          />
        </label>
        <label>
          <span>Port</span>
          <input
            value={profile.port}
            onChange={event => setField('port', Number(event.target.value))}
            type='number'
            min='1'
            max='65535'
            required
          />
        </label>
      </div>
      <label>
        <span>Username</span>
        <input
          value={profile.username}
          onChange={event => setField('username', event.target.value)}
          placeholder='root'
          required
        />
      </label>
      <div className='private-key-field'>
        <div className='private-key-header'>
          <label htmlFor='private-key-input'>Private key</label>
          <button
            type='button'
            className='reveal-toggle'
            aria-pressed={privateKeyRevealed}
            aria-controls='private-key-input'
            aria-label={
              privateKeyRevealed ? 'Hide private key' : 'Show private key'
            }
            onClick={() => setPrivateKeyRevealed(revealed => !revealed)}
          >
            {privateKeyRevealed ? 'Hide' : 'Show'}
          </button>
        </div>
        {/* SSH keys are multiline, so this must be a <textarea>, which has no
            native password masking. The value stays real (paste/edit/multiline
            keep working); only the rendered glyphs are hidden via CSS keyed on
            data-masked, so nothing is shoulder-surfed by default (#94). */}
        <textarea
          id='private-key-input'
          value={profile.privateKey}
          onChange={event => setField('privateKey', event.target.value)}
          rows={7}
          required
          data-masked={privateKeyRevealed ? 'false' : 'true'}
        />
      </div>
      <label className='file-loader'>
        <span>Load private key file</span>
        <input
          type='file'
          onChange={event => void readKeyFile(event.target.files?.[0])}
        />
      </label>
      <label>
        <span>Passphrase (optional)</span>
        <input
          value={profile.passphrase ?? ''}
          onChange={event =>
            setField('passphrase', event.target.value || undefined)
          }
          type='password'
        />
      </label>
      <button type='submit'>Continue to fingerprint</button>
      <p className='fine-print'>
        The MVP does not save keys, profiles, known_hosts, or terminal
        transcripts.
      </p>
    </form>
  );
}

function HostKeyGate({
  pending,
  onBack,
  onTrust,
}: {
  pending: PendingHostKey;
  onBack(): void;
  onTrust(): void;
}) {
  return (
    <section className='glass-card hostkey-card'>
      <p className='eyebrow'>Server identity</p>
      <h2>Confirm SSH host key</h2>
      <p>
        This MVP does not keep persistent known_hosts yet. Compare the
        fingerprint with your server before trusting it for this session.
      </p>
      <dl className='fingerprint-box'>
        <div>
          <dt>Host</dt>
          <dd>
            {pending.profile.host}:{pending.profile.port}
          </dd>
        </div>
        <div>
          <dt>Fingerprint</dt>
          <dd>{pending.fingerprint}</dd>
        </div>
      </dl>
      <div className='button-row'>
        <button type='button' className='ghost-button' onClick={onBack}>
          Back
        </button>
        <button type='button' onClick={onTrust}>
          Trust for this session
        </button>
      </div>
    </section>
  );
}
