export type HostClipboardWriter = (text: string) => Promise<void> | void;

/**
 * Owns OSC 52 consent for exactly one live terminal session.
 *
 * The UI decides when to enable the session and how to present pending text;
 * this object keeps the security-sensitive ordering independent of React. In
 * particular, reject clears the proposal without ever receiving a clipboard
 * writer, and accept consumes the proposal before invoking one.
 */
export class ClipboardWriteConsentSession {
  private writesEnabled = false;
  private pendingWrite: string | null = null;

  get enabled(): boolean {
    return this.writesEnabled;
  }

  get pendingText(): string | null {
    return this.pendingWrite;
  }

  enable(): void {
    this.writesEnabled = true;
  }

  disable(): void {
    this.writesEnabled = false;
    this.pendingWrite = null;
  }

  request(text: string): boolean {
    if (!this.writesEnabled || this.pendingWrite !== null) return false;
    this.pendingWrite = text;
    return true;
  }

  reject(): void {
    this.pendingWrite = null;
  }

  async accept(writeClipboard: HostClipboardWriter): Promise<boolean> {
    const text = this.pendingWrite;
    this.pendingWrite = null;
    if (!this.writesEnabled || text === null) return false;

    await writeClipboard(text);
    return true;
  }
}
