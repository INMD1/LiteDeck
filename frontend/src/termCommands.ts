// Terminal actions that come from outside the terminal — the command palette,
// mostly — delivered to whichever terminal view is on screen.
//
// A bus rather than a ref passed down: the palette lives at the top of the app
// and the terminal several screens below it, and the only thing they share is
// that one of them asks and the other, if it is showing, acts.

export type TermAction =
  | 'new-tab'
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'focus-left'
  | 'focus-right'
  | 'focus-up'
  | 'focus-down'
  | 'font-bigger'
  | 'font-smaller'
  | 'font-reset'

const listeners = new Set<(a: TermAction) => boolean>()

/** Registers a handler. It returns true when it acted — a hidden view says no
 *  and the next one is asked. */
export function onTermAction(fn: (a: TermAction) => boolean): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Sends an action to the visible terminal. False when none took it. */
export function runTermAction(a: TermAction): boolean {
  for (const fn of listeners) if (fn(a)) return true
  return false
}
