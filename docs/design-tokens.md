# Design Tokens

OMXTerm uses a hand-made terminal palette as the product palette. The visual
direction is dark, premium, sparse, and terminal-native: "nerd in a tuxedo", not
green Matrix cosplay.

## Core colors

```ts
export const omxtermColors = {
  bg: '#0f0f14',
  fg: '#eae8ff',
  black: '#06060c',
  white: '#f0efff',

  gray00: '#08080f',
  gray01: '#0a0a14',
  gray02: '#14141e',
  gray03: '#1c1c2a',
  gray04: '#242436',
  gray05: '#2c2c40',
  gray06: '#36364c',
  gray07: '#404058',
  gray08: '#4c4c66',
  gray09: '#565672',
  gray10: '#60607e',
  gray11: '#6a6a8a',
  gray12: '#747496',
  gray13: '#7e7ea0',
  gray14: '#8686a8',
  gray15: '#8e8eb0',
  gray16: '#9696b8',
  gray17: '#9e9ec0',
  gray18: '#a4a4c4',
  gray19: '#acacca',
  gray20: '#b4b4d0',
  gray21: '#b8b8d4',
  gray22: '#c0c0da',
  gray23: '#c8c8e2',
  gray24: '#cecee8',
  gray25: '#d2d2ec',
  gray26: '#dadaf2',
  gray27: '#e2e2f6',

  red: '#ff5f81',
  redVivid: '#ff7e9a',
  redRose: '#ffa8bb',
  orange: '#ff9060',
  peach: '#ffb098',
  yellow: '#ffda76',

  green: '#37feb7',
  greenLight: '#72ffcd',
  greenMint: '#a0ffe0',

  cyan: '#6bccff',
  teal: '#77dbff',
  tealBright: '#8ce0fe',
  tealDark: '#0c1d2b',

  blue: '#88aaf2',
  blueLight: '#b2cbff',
  blueSky: '#78a0e8',
  blueSoft: '#8890d8',
  blueVivid: '#5070ff',
  blueDeep: '#4838a0',
  aqua: '#60ffd8',

  purple: '#b080ff',
  lavender: '#9898e0',
  purpleLight: '#c8a0ff',
  magenta: '#ff87bc',
  magentaVivid: '#ff88ef',
} as const;
```

## Product roles

- Page background: `bg`
- Deep backdrop: `black` / `gray00`
- Main surfaces: `gray02`, `gray03`
- Elevated surfaces: `gray04`, `gray05`
- Borders: `gray06` with transparency
- Primary text: `fg`
- Muted text: `gray16` down to `gray11`
- Comments/helper text: `gray08`
- Primary accent: `cyan`
- Links/focus/borders: `teal`
- Secondary accent: `blue`
- Premium glow: `purple`/`blueDeep` at low opacity only
- Danger: `redVivid`
- Warning: `yellow`
- Success: `green`, but only for semantic success states and ANSI terminal
  output, never as the product identity.

## xterm.js ANSI palette

Map ANSI colors to:

- black: `#0f0f14`
- red: `#ff7e9a`
- green: `#37feb7`
- yellow: `#ffda76`
- blue: `#88aaf2`
- magenta: `#ff87bc`
- cyan: `#6bccff`
- white: `#d6d1ff`
- brightBlack: `#505068`
- brightRed: `#ffa8bb`
- brightGreen: `#72ffcd`
- brightYellow: `#ffeab2`
- brightBlue: `#b2cbff`
- brightMagenta: `#ff88ef`
- brightCyan: `#77c6ff`
- brightWhite: `#f0efff`
- foreground: `#eae8ff`
- background: `#0f0f14`
- cursor: `#d6d1ff`
- selectionBackground: `#3b4fa6`

## Design rules

- Avoid Matrix green as a brand accent.
- Use cyan/teal as the primary accent.
- Keep backgrounds nearly black with blue-purple-tinted grays.
- Use wide negative space and restrained chrome.
- Do not invent fake metrics or decorative dashboards.
- The terminal is the product object; surrounding UI should feel quiet and
  expensive.
