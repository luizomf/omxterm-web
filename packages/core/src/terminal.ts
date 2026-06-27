export type TerminalStatus = 'idle' | 'connecting' | 'awaiting-host-trust' | 'connected' | 'closing' | 'closed' | 'error';

export type Unsubscribe = () => void;

export type TerminalTransportAdapter = {
  connect(): Promise<void>;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onOutput(handler: (data: string) => void): Unsubscribe;
  onStatusChange(handler: (status: TerminalStatus) => void): Unsubscribe;
  onError(handler: (message: string) => void): Unsubscribe;
};
