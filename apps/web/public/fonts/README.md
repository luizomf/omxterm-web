# Terminal webfont

`JetBrainsMono Nerd Font Mono`, self-hosted so the browser SSH terminal renders
powerline/icon glyphs without depending on the host having a Nerd Font installed.
We self-host (no CDN) to respect the broker's egress posture.

- **Source:** [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts)
  release, `JetBrainsMono.zip` (v3.4.0).
- **Variant:** `Mono` — icons are constrained to a single cell so they never
  break the terminal grid alignment.
- **Weights shipped:** Regular (400) and Bold (700).
- **License:** SIL Open Font License 1.1 — see [`OFL.txt`](./OFL.txt).

## Regenerating the `.woff2` files

The release ships `.ttf`; we convert to `.woff2` for the web (~1 MB/weight):

```sh
pip install fonttools brotli
fonttools ttLib.woff2 compress JetBrainsMonoNerdFontMono-Regular.ttf
fonttools ttLib.woff2 compress JetBrainsMonoNerdFontMono-Bold.ttf
```

The `@font-face` declarations live in `apps/web/src/ui/styles.css`; the terminal
references the family in `apps/web/src/terminal/TerminalEmulator.tsx`.
