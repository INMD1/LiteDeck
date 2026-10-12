import type { AIRecord } from './ipc'

// The AI work graph's shape (§6.3 of the next spec). Pure: records in, boxes and
// lines out, so it can be checked without a screen.
//
// # Layout
//
// Not a general graph layout. Every node here has a host, a time and a thing it
// touched, and those three are the layout:
//
//   - each host is a horizontal band, so a session that crossed three servers
//     reads as three rows of work rather than one tangle;
//   - inside a band, each target gets a row of its own — nginx.conf, nginx,
//     the commands — so "read, then edit, then edit again" is a straight line;
//   - left to right is the order things happened, one column per step, shared
//     across bands so the same moment lines up on every host.
//
// Deterministic by construction: the same records draw the same picture, and a
// new record only ever adds a column on the right. A force layout would move
// everything every time a node arrived, which is exactly when somebody is
// watching.
//
// # Edges, and the ones that are not drawn
//
// Only what the record says for certain. Two calls about the same file, unit,
// container or process are linked in order. A file change is linked to a later
// restart of the service that file belongs to, by a short table — and a file
// not in the table is linked to nothing. A shell command's effect cannot be
// known from its text, so commands are placed in time and linked to nothing.

export type NodeKind = AIRecord['kind'] | 'reads' | 'group'

export interface GraphNode {
  id: string
  kind: NodeKind
  host: string
  /** The row key inside the host band. */
  row: string
  col: number
  /** The records behind this node — one, or a folded run of them. */
  recs: AIRecord[]
  label: string
  result: AIRecord['result']
  /** Set on a folded run of reads, which can be opened. */
  fold?: string
  /** Every read behind this node found nothing — see isMissing. */
  missing?: boolean
}

export interface GraphEdge {
  from: string
  to: string
  /** 'same' links calls about one target; 'affects' a file to its service. */
  kind: 'same' | 'affects'
}

export interface Lane {
  host: string
  rows: { key: string; label: string }[]
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  lanes: Lane[]
  cols: number
  /** Past MAX_NODES the graph is drawn one node per target. */
  folded: boolean
}

/** Past this many nodes, a graph is drawn one node per target. Five hundred
 *  boxes on screen is a texture, not a picture. */
export const MAX_NODES = 500

const CHANGE_KINDS = new Set(['file_write', 'file_delete', 'service', 'process', 'container', 'command'])

/** A read that found nothing at the path it was given — "is it gone?" asked
 *  after a delete, most often. That is an answer, not a failure, and drawing it
 *  in red made a clean-up look like something had gone wrong. */
export function isMissing(r: AIRecord): boolean {
  return (
    r.kind === 'read' &&
    r.result === 'failed' &&
    /does not exist|no such file|not found|cannot find/i.test(r.error ?? '')
  )
}

export function isChange(r: AIRecord): boolean {
  return CHANGE_KINDS.has(r.kind)
}

// ----------------------------------------------------------------- sessions

export interface Session {
  id: string
  client: string
  clientLabel: string
  hosts: string[]
  start: number
  end: number
  changes: number
  failed: number
  declined: number
  reads: number
  /** Restarts, signals and commands that ran — things no revert touches. */
  irreversible: number
  /** A call is in flight, or the last one was moments ago. An agent pauses to
   *  think between calls; a session is not over because one call ended. */
  running: boolean
}

/** How long after its last call a session still counts as live. */
export const LIVE_FOR = 2 * 60_000

/** A record's session, or a stand-in for one recorded before sessions were. */
export function sessionKey(r: AIRecord): string {
  return r.session || `${r.client || 'default'}:none`
}

/** Sessions, most recent activity first. Restores are a person's work and do
 *  not make a session look active. */
export function sessions(recs: AIRecord[], host?: string, now = Date.now()): Session[] {
  const by = new Map<string, Session>()
  for (const r of recs) {
    if (r.kind === 'restore') continue
    const id = sessionKey(r)
    let s = by.get(id)
    if (!s) {
      s = {
        id,
        client: r.client || 'default',
        clientLabel: r.clientLabel || '',
        hosts: [],
        start: r.at,
        end: r.ended || r.at,
        changes: 0,
        failed: 0,
        declined: 0,
        reads: 0,
        irreversible: 0,
        running: false,
      }
      by.set(id, s)
    }
    if (r.hostId && !s.hosts.includes(r.hostId)) s.hosts.push(r.hostId)
    s.start = Math.min(s.start, r.at)
    s.end = Math.max(s.end, r.ended || r.at)
    if (r.clientLabel) s.clientLabel = r.clientLabel
    if (r.result === 'running') s.running = true
    if (r.kind === 'read') s.reads++
    else if (r.result === 'ok') s.changes++
    if (r.result === 'failed' && !isMissing(r)) s.failed++
    if (r.result === 'declined') s.declined++
    if (r.result === 'ok' && (r.kind === 'service' || r.kind === 'process' || r.kind === 'container' || r.kind === 'command'))
      s.irreversible++
  }
  let out = [...by.values()]
  for (const s of out) if (now - s.end < LIVE_FOR) s.running = true
  if (host) out = out.filter((s) => s.hosts.includes(host))
  return out.sort((a, b) => b.end - a.end)
}

// ------------------------------------------------------- file → service map

/** Which services a file belongs to. Deliberately short: a guess drawn as a
 *  line is a claim, and a claim the record cannot back is worse than no line. */
const OWNERS: [RegExp, string[]][] = [
  [/^\/etc\/nginx\//, ['nginx']],
  [/^\/etc\/ssh\/sshd_config/, ['ssh', 'sshd']],
  [/^\/etc\/apache2\//, ['apache2']],
  [/^\/etc\/httpd\//, ['httpd']],
  [/^\/etc\/caddy\//, ['caddy']],
  [/^\/etc\/haproxy\//, ['haproxy']],
  [/^\/etc\/mysql\//, ['mysql', 'mariadb']],
  [/^\/etc\/postgresql\//, ['postgresql']],
  [/^\/etc\/redis\//, ['redis', 'redis-server']],
  [/^\/etc\/docker\/daemon\.json$/, ['docker']],
  [/^\/etc\/fail2ban\//, ['fail2ban']],
  [/^\/etc\/php\/[^/]+\/fpm\//, ['php-fpm']],
]

function unitName(u: string): string {
  return u.replace(/\.service$/, '')
}

/** The services a file change can be said to affect. */
export function servicesFor(path: string): string[] {
  // A unit file belongs to its own unit, whatever it is called.
  const unit = /^\/(?:etc|lib|usr\/lib)\/systemd\/system\/([^/]+)\.service$/.exec(path)
  if (unit) return [unit[1]]
  for (const [re, names] of OWNERS) if (re.test(path)) return names
  return []
}

export function affects(path: string, unit: string): boolean {
  const u = unitName(unit)
  // php8.2-fpm and friends: the version is in the unit name, not the path.
  return servicesFor(path).some((s) => s === u || (s === 'php-fpm' && /^php[\d.]*-fpm$/.test(u)))
}

// ------------------------------------------------------------------ layout

function rowOf(r: AIRecord): string {
  switch (r.kind) {
    case 'command':
      return 'cmd'
    case 'read':
      return r.target ? `t:${r.target}` : 'reads'
    case 'service':
      return `svc:${unitName(r.target || '')}`
    default:
      return `t:${r.target || r.tool}`
  }
}

function labelOf(r: AIRecord): string {
  // Both separators: a Windows server's paths arrive as C:\Users\me\a.txt.
  const base = (r.target || '').split(/[\\/]/).filter(Boolean).pop() || r.target || r.tool
  switch (r.kind) {
    case 'file_write':
      return base
    case 'file_delete':
      return base
    case 'service':
    case 'container':
      return `${r.action || ''} ${r.target || ''}`.trim()
    case 'process':
      return `${r.action || 'TERM'} ${r.target || ''}`.trim()
    case 'command':
      return r.target || ''
    default:
      return r.target ? base : r.tool
  }
}

const RESULT_RANK: Record<AIRecord['result'], number> = { ok: 0, running: 1, declined: 2, failed: 3 }

function worst(recs: AIRecord[]): AIRecord['result'] {
  let w: AIRecord['result'] = 'ok'
  for (const r of recs) {
    const res = isMissing(r) ? 'ok' : r.result
    if (RESULT_RANK[res] > RESULT_RANK[w]) w = res
  }
  return w
}

/**
 * Lays out one session's records.
 *
 * `open` names the folded read runs somebody expanded. Reads fold by default
 * into one node per run between two changes on the same host: a diagnosis is
 * a dozen reads, and a dozen boxes ahead of the one edit hide the edit.
 */
export function layout(recs: AIRecord[], open: Set<string> = new Set()): Graph {
  const work = recs.filter((r) => r.kind !== 'restore').sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))

  // Steps: a change, a run of folded reads, or an opened read.
  type Step = { kind: NodeKind; host: string; recs: AIRecord[]; fold?: string }
  const steps: Step[] = []
  const runOf = new Map<string, Step>() // host → the read run still open
  for (const r of work) {
    const host = r.hostId || ''
    if (r.kind === 'read') {
      const run = runOf.get(host)
      if (run) {
        run.recs.push(r)
        continue
      }
      const s: Step = { kind: 'reads', host, recs: [r], fold: `reads:${host}:${r.id}` }
      runOf.set(host, s)
      steps.push(s)
      continue
    }
    runOf.delete(host)
    steps.push({ kind: r.kind, host, recs: [r] })
  }

  // Opened runs become their reads again, each in its own column.
  const expanded: Step[] = []
  for (const s of steps) {
    if (s.kind === 'reads' && s.fold && (open.has(s.fold) || s.recs.length === 1)) {
      for (const r of s.recs) expanded.push({ kind: 'read', host: s.host, recs: [r] })
    } else expanded.push(s)
  }

  let folded = false
  let final = expanded
  if (expanded.length > MAX_NODES) {
    folded = true
    final = foldByTarget(work)
  }

  const nodes: GraphNode[] = []
  const lanes = new Map<string, Lane>()
  final.forEach((s, col) => {
    const head = s.recs[0]
    const row = s.kind === 'reads' ? 'reads' : s.kind === 'group' ? `g:${rowOf(head)}` : rowOf(head)
    let lane = lanes.get(s.host)
    if (!lane) {
      lane = { host: s.host, rows: [] }
      lanes.set(s.host, lane)
    }
    if (!lane.rows.some((x) => x.key === row)) {
      lane.rows.push({ key: row, label: row === 'reads' ? '' : row === 'cmd' ? '' : head.target || head.tool })
    }
    nodes.push({
      id: s.fold ?? (s.kind === 'group' ? `g:${s.host}:${row}` : head.id),
      kind: s.kind,
      host: s.host,
      row,
      col,
      recs: s.recs,
      label: s.kind === 'reads' || s.kind === 'group' ? '' : labelOf(head),
      result: worst(s.recs),
      fold: s.fold,
      missing: s.recs.length > 0 && s.recs.every(isMissing),
    })
  })

  // Reads on top, commands at the bottom, the things being changed between.
  // A file-to-service line then runs between two target rows and never passes
  // through a command, which would read as the command being part of it.
  const place = (key: string) => (key === 'reads' ? 0 : key === 'cmd' || key === 'g:cmd' ? 2 : 1)
  for (const lane of lanes.values()) {
    lane.rows = lane.rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => place(a.r.key) - place(b.r.key) || a.i - b.i)
      .map((x) => x.r)
  }

  return { nodes, edges: edgesOf(nodes), lanes: [...lanes.values()], cols: final.length, folded }
}

/** One node per target, for a session too large to draw call by call. */
function foldByTarget(work: AIRecord[]) {
  const by = new Map<string, { kind: NodeKind; host: string; recs: AIRecord[] }>()
  for (const r of work) {
    const host = r.hostId || ''
    const key = `${host}\u0000${r.kind === 'read' ? 'reads' : rowOf(r)}`
    let g = by.get(key)
    if (!g) {
      g = { kind: r.kind === 'read' ? 'reads' : 'group', host, recs: [] }
      by.set(key, g)
    }
    g.recs.push(r)
  }
  return [...by.values()]
}

function edgesOf(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = []
  // Same target, in order. Commands are never linked: their effect is not in
  // the record. A folded run of reads is about nothing in particular.
  const last = new Map<string, GraphNode>()
  for (const n of nodes) {
    if (n.kind === 'command' || n.kind === 'reads' || n.row === 'cmd' || n.row === 'reads') continue
    const key = `${n.host}\u0000${n.row.replace(/^g:/, '')}`
    const prev = last.get(key)
    if (prev) edges.push({ from: prev.id, to: n.id, kind: 'same' })
    last.set(key, n)
  }

  // A file change, then a restart of the service it belongs to. Only the last
  // change to each file before that restart, and only once per restart.
  const changed = new Map<string, GraphNode>() // host + path → its latest change
  for (const n of nodes) {
    const r = n.recs[n.recs.length - 1]
    if ((n.kind === 'file_write' || n.kind === 'file_delete' || n.kind === 'group') &&
      (r.kind === 'file_write' || r.kind === 'file_delete') && r.result === 'ok' && r.target) {
      changed.set(`${n.host}\u0000${r.target}`, n)
      continue
    }
    if (r.kind !== 'service' || r.result !== 'ok' || !r.target) continue
    for (const [key, f] of changed) {
      const [host, path] = key.split('\u0000')
      if (host !== n.host || !affects(path, r.target)) continue
      edges.push({ from: f.id, to: n.id, kind: 'affects' })
      changed.delete(key)
    }
  }
  return edges
}
