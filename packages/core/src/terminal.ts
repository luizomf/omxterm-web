export type TerminalStatus = 'idle' | 'connecting' | 'awaiting-host-trust' | 'connected' | 'closing' | 'closed' | 'error';

export type Unsubscribe = () => void;

export type OutputConsumed = () => void;

export type TerminalTransportAdapter = {
  connect(): Promise<void>;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  // The consumer calls `consumed` only after its parser has finished the block.
  // This is transport-neutral: WebSocket adapters may turn it into output
  // credit while another adapter can treat it as a no-op completion signal.
  onOutput(handler: (data: string, consumed: OutputConsumed) => void): Unsubscribe;
  onStatusChange(handler: (status: TerminalStatus) => void): Unsubscribe;
  onError(handler: (message: string) => void): Unsubscribe;
};
