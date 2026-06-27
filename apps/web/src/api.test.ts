import { describe, expect, test } from 'vitest';
import { buildWebSocketUrl } from './api';

describe('buildWebSocketUrl', () => {
  test('adds the terminal ticket and uses websocket protocol', () => {
    expect(buildWebSocketUrl('/terminal/ws', 'ticket-123')).toBe(`${window.location.origin.replace('http', 'ws')}/terminal/ws?ticket=ticket-123`);
  });
});
