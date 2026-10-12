// Split terminals: the shape of one terminal tab (§5.2 of the next spec).
//
// A tab is a binary tree. A leaf is one pane, which is one shell channel on the
// SSH connection that is already open; a split holds two subtrees side by side
// (`row`) or one above the other (`col`). Binary rather than n-ary because every
// split a person makes is "this pane, in two", and a tree that only ever grows
// that way never needs rebalancing.
//
// Everything here is pure. The view owns the channels; this file only answers
// questions about shape — where a new pane goes, what is left when one closes,
// what to remember for the next launch.

export type Dir = 'row' | 'col'

export type Layout =
  | { kind: 'pane'; term: string }
  | { kind: 'split'; dir: Dir; ratio: number; a: Layout; b: Layout }

export interface TermTab {
  /** Stable key for React. Not a terminal id: the first pane can close and the
   *  tab carry on with the second. */
  key: string
  root: Layout
  /** The pane the keyboard goes to. */
  focus: string
}

/** Every terminal id in a layout, left to right, top to bottom. */
export function panes(node: Layout): string[] {
  return node.kind === 'pane' ? [node.term] : [...panes(node.a), ...panes(node.b)]
}

/** Replaces the pane `term` with a split of it and `added`. */
export function splitPane(node: Layout, term: string, added: string, dir: Dir): Layout {
  if (node.kind === 'pane') {
    if (node.term !== term) return node
    return { kind: 'split', dir, ratio: 0.5, a: node, b: { kind: 'pane', term: added } }
  }
  return { ...node, a: splitPane(node.a, term, added, dir), b: splitPane(node.b, term, added, dir) }
}

/** Removes a pane; its sibling takes the whole of their parent's space.
 *  Returns null when the pane was the last one. */
export function removePane(node: Layout, term: string): Layout | null {
  if (node.kind === 'pane') return node.term === term ? null : node
  const a = removePane(node.a, term)
  const b = removePane(node.b, term)
  if (!a) return b
  if (!b) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** Sets the ratio of the split at `path` (a string of 'a'/'b' steps). */
export function setRatio(node: Layout, path: string, ratio: number): Layout {
  if (node.kind === 'pane') return node
  if (path === '') return { ...node, ratio: clampRatio(ratio) }
  const [step, rest] = [path[0], path.slice(1)]
  return step === 'a'
    ? { ...node, a: setRatio(node.a, rest, ratio) }
    : { ...node, b: setRatio(node.b, rest, ratio) }
}

/** A pane narrower than this is a pane nobody can read; the divider stops. */
export function clampRatio(r: number): number {
  return Math.max(0.15, Math.min(0.85, Number.isFinite(r) ? r : 0.5))
}

/** Keeps only the panes whose terminals are still running. */
export function prune(node: Layout, alive: Set<string>): Layout | null {
  if (node.kind === 'pane') return alive.has(node.term) ? node : null
  const a = prune(node.a, alive)
  const b = prune(node.b, alive)
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

// ----------------------------------------------------------------- memory

/** What is remembered across launches: the shape, not the sessions.
 *
 *  A shell does not survive the app closing — the channel goes with the
 *  connection, and nothing is left running on the server (§5.2: this is not
 *  tmux). So the next launch gets the same arrangement with fresh shells in it,
 *  which is the part of "the same layout" that is actually possible. */
export type Shape = { kind: 'pane' } | { kind: 'split'; dir: Dir; ratio: number; a: Shape; b: Shape }

export function shapeOf(node: Layout): Shape {
  return node.kind === 'pane'
    ? { kind: 'pane' }
    : { kind: 'split', dir: node.dir, ratio: node.ratio, a: shapeOf(node.a), b: shapeOf(node.b) }
}

export function countPanes(s: Shape): number {
  return s.kind === 'pane' ? 1 : countPanes(s.a) + countPanes(s.b)
}

/** Fills a shape with terminal ids, in pane order. Panes without an id — the
 *  server refused more channels — are left out rather than drawn empty. */
export function fill(s: Shape, terms: (string | null)[], at = { i: 0 }): Layout | null {
  if (s.kind === 'pane') {
    const t = terms[at.i++]
    return t ? { kind: 'pane', term: t } : null
  }
  const a = fill(s.a, terms, at)
  const b = fill(s.b, terms, at)
  if (!a) return b
  if (!b) return a
  return { kind: 'split', dir: s.dir, ratio: clampRatio(s.ratio), a, b }
}

/** Reads a stored shape, refusing anything that is not one. A hand-edited or
 *  half-written entry is a single pane, not an exception at startup. */
export function parseShape(v: unknown, depth = 0): Shape | null {
  if (!v || typeof v !== 'object' || depth > 8) return null
  const o = v as Record<string, unknown>
  if (o.kind === 'pane') return { kind: 'pane' }
  if (o.kind !== 'split' || (o.dir !== 'row' && o.dir !== 'col')) return null
  const a = parseShape(o.a, depth + 1)
  const b = parseShape(o.b, depth + 1)
  if (!a || !b) return null
  return { kind: 'split', dir: o.dir, ratio: clampRatio(Number(o.ratio)), a, b }
}

const STORE = 'litedeck.termLayout.'

/** The shapes of a host's tabs from the last time it was open. */
export function loadShapes(hostID: string): Shape[] {
  try {
    const raw = window.localStorage.getItem(STORE + hostID)
    if (!raw) return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.map((s) => parseShape(s)).filter((s): s is Shape => s !== null)
  } catch {
    return []
  }
}

export function saveShapes(hostID: string, tabs: TermTab[]) {
  try {
    // Only splits are worth remembering. A tab that is one pane is what the
    // terminal opens with anyway, and storing it would mean a host somebody
    // opened once grows a list of single tabs that all reopen next time.
    const shapes = tabs.map((t) => shapeOf(t.root)).filter((s) => s.kind === 'split')
    if (shapes.length === 0) window.localStorage.removeItem(STORE + hostID)
    else window.localStorage.setItem(STORE + hostID, JSON.stringify(shapes))
  } catch {
    // A full or blocked store costs the arrangement at next launch, not now.
  }
}

// ----------------------------------------------------------------- focus

export type Way = 'left' | 'right' | 'up' | 'down'

/** The pane whose box lies in direction `way` from `from`, nearest first.
 *
 *  Measured from the boxes on screen rather than walked through the tree. The
 *  tree answers "what is next to this" badly for anything but its own parent —
 *  moving right from the bottom-left pane of a 2×2 should land on the
 *  bottom-right one, which is a cousin, not a sibling. */
export function neighbour(
  from: string,
  way: Way,
  boxes: Map<string, { x: number; y: number; w: number; h: number }>,
): string | null {
  const f = boxes.get(from)
  if (!f) return null
  const cx = f.x + f.w / 2
  const cy = f.y + f.h / 2
  let best: string | null = null
  let bestScore = Infinity
  for (const [id, b] of boxes) {
    if (id === from) continue
    const bx = b.x + b.w / 2
    const by = b.y + b.h / 2
    const ahead =
      way === 'left' ? f.x - (b.x + b.w) : way === 'right' ? b.x - (f.x + f.w)
        : way === 'up' ? f.y - (b.y + b.h) : b.y - (f.y + f.h)
    // Touching or beyond the edge in that direction. The boxes are fractions of
    // the tab, so the slack is one too — a pixel count here (it was -4) let
    // every pane through, and ⌘⌥← from the bottom-right of three went up
    // instead of left.
    if (ahead < -0.005) continue
    const across = way === 'left' || way === 'right' ? Math.abs(by - cy) : Math.abs(bx - cx)
    const score = ahead * 4 + across
    if (score < bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

// ----------------------------------------------------------------- geometry

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Divider {
  /** Where the split sits in the tree, for setRatio. */
  path: string
  dir: Dir
  /** The whole split's box — a drag maps a pointer position inside it to a ratio. */
  span: Box
  /** The line itself. */
  at: Box
}

/** Each pane's box, as fractions of the tab, plus the dividers between them.
 *
 *  Computed rather than nested in the DOM. Nesting would put a pane inside a new
 *  wrapper the moment it is split, and React treats a component that moved to a
 *  new parent as a new component — the terminal in it would be torn down and
 *  rebuilt, and its scrollback with it. Flat, absolutely placed panes keep their
 *  identity however the tree around them changes. */
export function geometry(
  node: Layout,
  box: Box = { x: 0, y: 0, w: 1, h: 1 },
  path = '',
  out: { panes: Map<string, Box>; dividers: Divider[] } = { panes: new Map(), dividers: [] },
) {
  if (node.kind === 'pane') {
    out.panes.set(node.term, box)
    return out
  }
  const r = clampRatio(node.ratio)
  if (node.dir === 'row') {
    const aw = box.w * r
    geometry(node.a, { x: box.x, y: box.y, w: aw, h: box.h }, path + 'a', out)
    geometry(node.b, { x: box.x + aw, y: box.y, w: box.w - aw, h: box.h }, path + 'b', out)
    out.dividers.push({ path, dir: 'row', span: box, at: { x: box.x + aw, y: box.y, w: 0, h: box.h } })
  } else {
    const ah = box.h * r
    geometry(node.a, { x: box.x, y: box.y, w: box.w, h: ah }, path + 'a', out)
    geometry(node.b, { x: box.x, y: box.y + ah, w: box.w, h: box.h - ah }, path + 'b', out)
    out.dividers.push({ path, dir: 'col', span: box, at: { x: box.x, y: box.y + ah, w: box.w, h: 0 } })
  }
  return out
}
