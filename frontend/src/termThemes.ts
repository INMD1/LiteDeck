import type { ITheme } from '@xterm/xterm'
import { k } from './i18n'
import { resolvedTheme } from './theme'

// Terminal colour schemes (§5.3 of the next spec).
//
// # "App" is the default, and it is not a palette
//
// It reads the app's own tokens — background, text, accent, selection — so the
// terminal sits in the window rather than on top of it, and it changes when the
// app's theme does. Only the sixteen ANSI colours are fixed, one set for a light
// window and one for a dark one, because those are what programs ask for by
// number and the tokens have nothing to say about "bright magenta".
//
// # The rest are the ones people already know
//
// Copied as published by their authors rather than adjusted. Somebody who picks
// Solarized wants Solarized — their prompt, their `ls` colours and their vim
// scheme were all chosen against those exact values.

export type TermThemeId = 'app' | 'tokyo-night' | 'dracula' | 'solarized-dark' | 'solarized-light'

export const TERM_THEMES: { id: TermThemeId; label: string }[] = [
  { id: 'app', label: k('앱 테마 따라가기') },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'solarized-light', label: 'Solarized Light' },
]

export function isTermTheme(v: string): v is TermThemeId {
  return TERM_THEMES.some((t) => t.id === v)
}

type Ansi = Pick<
  ITheme,
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow'
  | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
>

// The two sets "app" uses. Picked against the app's own backgrounds so the
// normal colours clear 4.5:1 on them; the dark set leans cool to sit with the
// neon accent, the light one is the usual xterm set darkened until yellow and
// cyan are readable on white.
const ANSI_DARK: Ansi = {
  black: '#1b1d26', red: '#ff5f7a', green: '#5ef2a0', yellow: '#f5d76e',
  blue: '#6cb6ff', magenta: '#e07bff', cyan: '#4ee6f2', white: '#c9cdd8',
  brightBlack: '#6b7084', brightRed: '#ff8599', brightGreen: '#8bf7bd', brightYellow: '#fae69a',
  brightBlue: '#99ccff', brightMagenta: '#eba3ff', brightCyan: '#86eef6', brightWhite: '#f4f6fb',
}

const ANSI_LIGHT: Ansi = {
  black: '#1f2328', red: '#c4253b', green: '#1a7f37', yellow: '#8a6100',
  blue: '#0b5cc2', magenta: '#8a3fc7', cyan: '#0a7287', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#6f4e00',
  brightBlue: '#0550ae', brightMagenta: '#6e2fa8', brightCyan: '#075a6b', brightWhite: '#1f2328',
}

const FIXED: Record<Exclude<TermThemeId, 'app'>, ITheme> = {
  'tokyo-night': {
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
    brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
    brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
    brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'solarized-light': {
    background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
    brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
}

/** The xterm theme for a choice, resolved now — "app" reads the live tokens. */
export function termTheme(id: string): ITheme {
  if (isTermTheme(id) && id !== 'app') return FIXED[id as Exclude<TermThemeId, 'app'>]
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback
  const dark = resolvedTheme() === 'dark'
  return {
    background: v('--term-bg', v('--bg', dark ? '#14151c' : '#ffffff')),
    foreground: v('--term-fg', v('--fg', dark ? '#e6e8ef' : '#1f2328')),
    cursor: v('--term-cursor', v('--accent', '#0a84ff')),
    cursorAccent: v('--term-bg', v('--bg', dark ? '#14151c' : '#ffffff')),
    selectionBackground: v('--term-selection', v('--bg-selected', '#0a84ff40')),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}
