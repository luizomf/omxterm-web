import { WebSocket } from "ws";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1000;

type WebSocketHeartbeatOptions = {
  socket: WebSocket;
  intervalMs?: number;
  onTimeout: () => void;
};

/**
 * Starts a protocol-level ping/pong heartbeat for one WebSocket. A peer gets one
 * full interval to answer each ping; missing the next tick triggers onTimeout.
 * Returns an idempotent disposer for the owning connection's close path.
 */
export function startWebSocketHeartbeat({
  socket,
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  onTimeout,
}: WebSocketHeartbeatOptions): () => void {
  let awaitingPong = false;
  let stopped = false;

  const handlePong = () => {
    awaitingPong = false;
  };
  socket.on("pong", handlePong);

  const timer = setInterval(() => {
    if (awaitingPong) {
      stop();
      onTimeout();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    awaitingPong = true;
    socket.ping();
  }, intervalMs);
  timer.unref();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off("pong", handlePong);
  }

  return stop;
}
