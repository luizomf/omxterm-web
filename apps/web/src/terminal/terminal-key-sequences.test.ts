import { describe, expect, test } from 'vitest';
import {
  ARROW_DOWN_SEQUENCE,
  ARROW_LEFT_SEQUENCE,
  ARROW_RIGHT_SEQUENCE,
  ARROW_UP_SEQUENCE,
  CTRL_C_SEQUENCE,
  ESCAPE_SEQUENCE,
  TAB_SEQUENCE,
  applyStickyCtrlModifier,
  controlCharacterFor,
} from './terminal-key-sequences';

describe('named key bar sequences', () => {
  test('map Esc, Tab, and arrows to their ANSI/VT sequences', () => {
    expect(ESCAPE_SEQUENCE).toBe('\x1b');
    expect(TAB_SEQUENCE).toBe('\t');
    expect(ARROW_UP_SEQUENCE).toBe('\x1b[A');
    expect(ARROW_DOWN_SEQUENCE).toBe('\x1b[B');
    expect(ARROW_RIGHT_SEQUENCE).toBe('\x1b[C');
    expect(ARROW_LEFT_SEQUENCE).toBe('\x1b[D');
  });

  test('Ctrl-C shortcut sends the SIGINT control character', () => {
    expect(CTRL_C_SEQUENCE).toBe('\x03');
  });
});

describe('controlCharacterFor', () => {
  test('derives every Ctrl+a..z control character from a..z', () => {
    for (let code = 0; code < 26; code += 1) {
      const letter = String.fromCharCode('a'.charCodeAt(0) + code);
      expect(controlCharacterFor(letter)).toBe(String.fromCharCode(code + 1));
    }
  });

  test('is case-insensitive', () => {
    expect(controlCharacterFor('D')).toBe(controlCharacterFor('d'));
    expect(controlCharacterFor('D')).toBe('\x04');
  });

  test('matches the well-known Ctrl-C and Ctrl-D control codes', () => {
    expect(controlCharacterFor('c')).toBe('\x03');
    expect(controlCharacterFor('d')).toBe('\x04');
  });

  test('returns null for non-letters', () => {
    expect(controlCharacterFor('1')).toBeNull();
    expect(controlCharacterFor(' ')).toBeNull();
    expect(controlCharacterFor('!')).toBeNull();
  });

  test('returns null for multi-character input', () => {
    expect(controlCharacterFor('ab')).toBeNull();
    expect(controlCharacterFor('')).toBeNull();
  });
});

describe('applyStickyCtrlModifier', () => {
  test('passes input through unchanged and stays disarmed when not armed', () => {
    expect(applyStickyCtrlModifier('d', false)).toEqual({
      armed: false,
      output: 'd',
    });
  });

  test('converts the next letter to its control character and disarms', () => {
    expect(applyStickyCtrlModifier('d', true)).toEqual({
      armed: false,
      output: '\x04',
    });
  });

  test('disarms and passes through unchanged when the input is not Ctrl-able', () => {
    expect(applyStickyCtrlModifier('\r', true)).toEqual({
      armed: false,
      output: '\r',
    });
  });

  test('disarms and passes through multi-character input (e.g. paste) unchanged', () => {
    expect(applyStickyCtrlModifier('hello', true)).toEqual({
      armed: false,
      output: 'hello',
    });
  });
});
