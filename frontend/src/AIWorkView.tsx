import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffView } from './DiffView'
import { ResizeHandle } from './ResizeHandle'
import { usePref } from './prefs'
import {
  AIChange,
  AIRecords,
  AIRevert,
  AIRevertSession,
  on,
  type AIChangeView,
  type AIRecord,
  type AIRevertReport,
  type HostView,
} from './ipc'
import { isMissing, layout, sessions, sessionKey, type GraphNode, type Session } from './aiGraph'
import { clock, shortStamp } from './datetime'
import { k, t } from './i18n'

// The AI work screen (§6.3 of the next spec): what MCP clients did through this
// app, as a graph per session, with the file changes that can be put back.
//
// It adds no control over what an AI may do. The approval modes and switches
// are in the MCP panel, unchanged; this is somewhere to look afterwards — and,
// while an agent is working, somewhere to watch it happen.
//
// Loaded on demand, like the terminal: most sessions never open it.

const COL_W = 144
const ROW_H = 46
const LANE_HEAD = 30
const LANE_GAP = 14
const PAD_X = 24
const NODE_W = 128

// Zoom. A session opens as large as fits, but never smaller than can still be
// read — a long one scrolls rather than shrinking to a texture. "Fit" is the
// button for the whole of it at once, however small that makes it. Neither
// enlarges past 100%: a three-node session drawn twice its size is not easier
// to read, only bigger.
const MIN_ZOOM = 0.2
const READABLE = 0.6
const MAX_ZOOM = 2
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2]
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))

const GLYPH: Record<string, string> = {
  read: '◇',
  reads: '◇',
  file_write: '✎',
  file_delete: '⌫',
  service: '⟳',
  container: '▣',
  process: '✕',
  command: '$',
  group: '▦',
}

const KIND_LABEL: Record<string, string> = {
  read: k('조회'),
  reads: k('조회'),
  file_write: k('파일 쓰기'),
  file_delete: k('파일 삭제'),
  service: k('서비스 제어'),
  container: k('컨테이너 제어'),
  process: k('프로세스 종료'),
  command: k('임의 명령'),
  group: k('묶음'),
}

const STATE_LABEL: Record<string, string> = {
  revertible: k('되돌릴 수 있음'),
  changed: k('이후 다른 변경이 있었음'),
  expired: k('스냅샷 만료'),
  restored: k('되돌림'),
  nocopy: k('사본 없음'),
  offline: k('연결 안 됨'),
  irreversible: k('되돌릴 수 없는 작업'),
  notapplied: k('바뀐 것 없음'),
}

const STATE_NOTE: Record<string, string> = {
  revertible: k('서버의 파일이 AI가 쓴 그대로입니다. 되돌리면 바로 전 내용으로 돌아갑니다.'),
  changed: k('AI가 쓴 뒤에 이 파일이 다시 바뀌었습니다. 되돌리면 그 뒤의 변경도 함께 사라집니다.'),
  expired: k('보관 기간이 지나 이전 내용의 사본이 없습니다.'),
  restored: k('이미 되돌렸습니다.'),
  nocopy: k('파일이 너무 커서 이전 내용의 사본을 남기지 않았습니다.'),
  offline: k('이 호스트에 연결해야 서버의 파일과 비교할 수 있습니다.'),
  irreversible: k('서비스 재시작, 프로세스 종료, 임의 명령의 효과는 되돌릴 수 없습니다.'),
  notapplied: k('이 호출은 아무것도 바꾸지 않았습니다.'),
}

const SKIP_REASON: Record<string, string> = {
  changed: k('이후 다른 변경이 있었음'),
  expired: k('스냅샷 만료'),
  nocopy: k('사본 없음'),
  offline: k('연결 안 됨'),
  failed: k('실패'),
}

function clientName(s: { client: string; clientLabel: string }): string {
  return s.clientLabel || (s.client === 'default' ? t('기본') : s.client)
}

export function AIWorkView({
  hosts,
  onError,
  onOpenMCP,
}: {
  hosts: HostView[]
  onError: (msg: string) => void
  onOpenMCP: () => void
}) {
  const [recs, setRecs] = useState<AIRecord[] | null>(null)
  const [host, setHost] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [nodeID, setNodeID] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | 'fit' | 'auto'>('auto')
  const [view, setView] = useState({ w: 0, h: 0 })
  const detailWidth = usePref('aiDetailWidth')
  // A clock for "live": a session stops being live by time passing, not by a
  // record arriving, so something has to re-render when it does.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  // Everything recorded, then every record as it starts and as it finishes.
  // Upserted by ID: a call arrives once as running and again when it ends.
  useEffect(() => {
    let live = true
    AIRecords()
      .then((list) => live && setRecs(list ?? []))
      .catch((e) => {
        onError(String(e))
        if (live) setRecs([])
      })
    const off = on<AIRecord>('ai:record', (r) =>
      setRecs((prev) => {
        const list = prev ?? []
        const i = list.findIndex((x) => x.id === r.id)
        if (i < 0) return [...list, r]
        const next = list.slice()
        next[i] = r
        return next
      }),
    )
    return () => {
      live = false
      off()
    }
  }, [onError])

  const all = useMemo(() => sessions(recs ?? [], host || undefined, now), [recs, host, now])
  // Following the newest session until somebody picks one — so opening this
  // while an agent works shows that work, and keeps showing it.
  const current = all.find((s) => s.id === picked) ?? all[0] ?? null
  const sessRecs = useMemo(
    () =>
      current
        ? (recs ?? []).filter(
            (r) => sessionKey(r) === current.id && r.kind !== 'restore' && (!host || r.hostId === host),
          )
        : [],
    [recs, current, host],
  )
  const graph = useMemo(() => layout(sessRecs, open), [sessRecs, open])
  // Changes somebody has put back, so the graph can say so without a click.
  const restored = useMemo(() => {
    const out = new Set<string>()
    for (const r of recs ?? []) if (r.kind === 'restore' && r.result === 'ok' && r.restores) out.add(r.restores)
    return out
  }, [recs])
  const node = graph.nodes.find((n) => n.id === nodeID) ?? null

  const hostName = (id: string) => {
    const h = hosts.find((x) => x.id === id)
    // Calls about no server in particular — the list of servers itself.
    return h ? h.name || h.hostname : id || t('공통')
  }

  // Lane geometry: a band per host, a row per target inside it.
  const rowsY = new Map<string, number>()
  const laneBoxes: { host: string; y: number; h: number }[] = []
  let y = 0
  for (const lane of graph.lanes) {
    const top = y
    y += LANE_HEAD
    for (const r of lane.rows) {
      rowsY.set(`${lane.host}\u0000${r.key}`, y + ROW_H / 2)
      y += ROW_H
    }
    laneBoxes.push({ host: lane.host, y: top, h: y - top })
    y += LANE_GAP
  }
  const width = PAD_X * 2 + (Math.max(1, graph.cols) - 1) * COL_W + NODE_W
  const height = Math.max(y, 120)
  const pos = (n: GraphNode) => ({
    x: PAD_X + n.col * COL_W + NODE_W / 2,
    y: rowsY.get(`${n.host}\u0000${n.row}`) ?? 0,
  })

  const canvas = useRef<HTMLDivElement>(null)
  // The canvas's own size, for "fit". Measured rather than derived from the
  // window: the detail panel beside it is resizable.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [recs === null, (recs ?? []).length === 0])
  const fitZoom =
    view.w > 0 && view.h > 0 ? Math.max(MIN_ZOOM, Math.min(1, (view.w - 8) / width, (view.h - 16) / height)) : 1
  const z = zoom === 'fit' ? fitZoom : zoom === 'auto' ? Math.max(fitZoom, READABLE) : zoom

  // A new session starts afresh; one zoom does not suit every session.
  useEffect(() => setZoom('auto'), [current?.id])

  // Keep the newest step in view while it is being added to — not under "fit",
  // which already shows everything — and only as far as the
  // newest column needs, so the start of the session is not scrolled away.
  const following = !picked || picked === all[0]?.id
  useEffect(() => {
    const el = canvas.current
    if (!el || zoom === 'fit' || !following || !current?.running) return
    const right = width * z
    if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }, [graph.cols, following, current?.running, zoom, width, z])

  // Zoom about a point on the canvas, keeping what is under it where it is.
  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const el = canvas.current
      const to = clampZoom(next)
      if (!el) return setZoom(to)
      const px = at?.x ?? el.clientWidth / 2
      const py = at?.y ?? el.clientHeight / 2
      const gx = (el.scrollLeft + px) / z
      const gy = (el.scrollTop + py) / z
      setZoom(to)
      requestAnimationFrame(() => {
        el.scrollLeft = gx * to - px
        el.scrollTop = gy * to - py
      })
    },
    [z],
  )
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001)
    zoomTo(next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM))
  }

  // ⌘/Ctrl + wheel, and a trackpad pinch (which arrives as a wheel event with
  // ctrlKey set). Not passive: the page must not zoom instead.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const box = el.getBoundingClientRect()
      zoomTo(z * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - box.left, y: e.clientY - box.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [z, zoomTo])

  // Escape puts the detail away and gives its width back to the graph.
  useEffect(() => {
    if (!nodeID) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.scrim')) setNodeID(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nodeID])

  // Dragging the empty canvas moves it, the way a map does.
  const pan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.ai-node, .ai-zoom')) return
    const el = e.currentTarget
    const sx = e.clientX
    const sy = e.clientY
    const sl = el.scrollLeft
    const st = el.scrollTop
    el.setPointerCapture(e.pointerId)
    el.dataset.panning = ''
    const move = (ev: PointerEvent) => {
      el.scrollLeft = sl - (ev.clientX - sx)
      el.scrollTop = st - (ev.clientY - sy)
    }
    const up = () => {
      delete el.dataset.panning
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  if (recs === null) return <div className="placeholder">{t('불러오는 중…')}</div>

  if (recs.length === 0) {
    return (
      <div className="ai-work ai-empty">
        <div className="unavailable">
          <h3>{t('아직 AI 작업 기록이 없습니다')}</h3>
          <p className="muted">
            {t('Claude Code·Codex 같은 MCP 클라이언트가 LiteDeck을 통해 서버에서 한 일이 여기에 세션별 그래프로 쌓입니다.')}
          </p>
          <button className="primary" onClick={onOpenMCP}>
            {t('MCP 연동 설정')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ai-work">
      {/* The detail column exists only while a node is open. Empty, it was a
          third of the screen saying "click a node" — room the graph needed. */}
      <div
        className="ai-cols"
        style={{ gridTemplateColumns: node ? `220px minmax(0, 1fr) ${detailWidth}px` : '220px minmax(0, 1fr)' }}
      >
        <aside className="ai-sessions">
          <div className="ai-filter">
            <select className="input" value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="">{t('모든 호스트')}</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name || h.hostname}
                </option>
              ))}
            </select>
          </div>
          {all.length === 0 && <div className="placeholder small">{t('이 호스트의 기록이 없습니다.')}</div>}
          {all.map((s) => (
            <button
              key={s.id}
              className="ai-sess"
              data-on={s.id === current?.id || undefined}
              onClick={() => {
                setPicked(s.id)
                setNodeID(null)
                setOpen(new Set())
              }}
            >
              <div className="ai-sess-who">
                <span className="ellipsis">{clientName(s)}</span>
                {s.running && <span className="badge ai-live">{t('진행 중')}</span>}
              </div>
              <div className="ai-sess-meta mono">
                {shortStamp(s.start)} – {clock(s.end)}
              </div>
              <div className="ai-sess-meta ellipsis">{s.hosts.map(hostName).join(', ')}</div>
              <div className="ai-sess-counts">
                {s.changes > 0 && <span className="badge ai">{t('변경 {n}', { n: s.changes })}</span>}
                {s.failed > 0 && <span className="badge danger">{t('실패 {n}', { n: s.failed })}</span>}
                {s.declined > 0 && <span className="badge warn">{t('거부 {n}', { n: s.declined })}</span>}
                {s.reads > 0 && <span className="badge">{t('조회 {n}', { n: s.reads })}</span>}
              </div>
            </button>
          ))}
        </aside>

        <section className="ai-canvas-wrap">
          {current && <SessionBar session={current} hostName={hostName} onError={onError} />}
          {!node && graph.nodes.length > 0 && (
            <div className="ai-note muted small">{t('노드를 누르면 자세한 내용이 오른쪽에 나옵니다.')}</div>
          )}
          {graph.folded && (
            <div className="ai-note muted small">
              {t('노드가 {n}개를 넘어 대상별로 묶어 보여줍니다.', { n: 500 })}
            </div>
          )}
          <div className="ai-zoom" role="group" aria-label={t('확대·축소')}>
            <button className="ghost small-btn" onClick={() => step(-1)} title={t('축소')} aria-label={t('축소')}>
              −
            </button>
            <button
              className="ghost small-btn ai-zoom-pct mono"
              onClick={() => zoomTo(1)}
              title={t('100%로')}
            >
              {Math.round(z * 100)}%
            </button>
            <button className="ghost small-btn" onClick={() => step(1)} title={t('확대')} aria-label={t('확대')}>
              +
            </button>
            <button
              className="ghost small-btn"
              data-on={zoom === 'fit' || undefined}
              onClick={() => setZoom('fit')}
              title={t('세션 전체를 한 화면에')}
            >
              {t('맞춤')}
            </button>
          </div>
          <div className="ai-canvas" ref={canvas} onPointerDown={pan}>
            <div className="ai-sizer" style={{ width: width * z, height: height * z }}>
            {/* The host names sit outside the scaled plane: inside it they
                shrank with the zoom and, scaled, could not stay pinned to the
                left edge — scrolling cut "prod-web" down to "-web". */}
            {laneBoxes.map((l) => (
              <div key={`label:${l.host}`} className="ai-lane-tag" style={{ top: l.y * z }}>
                <span className="ai-lane-label">{hostName(l.host)}</span>
              </div>
            ))}
            <div className="ai-plane" style={{ width, height, transform: `scale(${z})` }}>
              {laneBoxes.map((l) => (
                <div key={l.host} className="ai-lane" style={{ top: l.y, height: l.h }} />
              ))}
              <svg className="ai-edges" width={width} height={height} aria-hidden="true">
                {graph.edges.map((e) => {
                  const a = graph.nodes.find((n) => n.id === e.from)
                  const b = graph.nodes.find((n) => n.id === e.to)
                  if (!a || !b) return null
                  const p = pos(a)
                  const q = pos(b)
                  const x1 = p.x + NODE_W / 2
                  const x2 = q.x - NODE_W / 2
                  const mid = (x1 + x2) / 2
                  return (
                    <path
                      key={`${e.from}>${e.to}`}
                      className="ai-edge"
                      data-kind={e.kind}
                      d={`M${x1} ${p.y} C ${mid} ${p.y}, ${mid} ${q.y}, ${x2} ${q.y}`}
                    />
                  )
                })}
              </svg>
              {graph.nodes.map((n) => {
                const p = pos(n)
                return (
                  <button
                    key={n.id}
                    className="ai-node"
                    data-kind={n.kind}
                    data-result={n.result}
                    data-sel={n.id === nodeID || undefined}
                    data-restored={(n.recs[0].snapshot && restored.has(n.recs[0].snapshot)) || undefined}
                    style={{ left: p.x - NODE_W / 2, top: p.y - 15, width: NODE_W }}
                    title={nodeTitle(n)}
                    onClick={() => setNodeID(n.id)}
                    onDoubleClick={() => n.fold && setOpen((s) => new Set(s).add(n.fold!))}
                  >
                    <span className="ai-glyph" aria-hidden="true">
                      {GLYPH[n.kind] ?? '•'}
                    </span>
                    <span className="ellipsis">{nodeLabel(n)}</span>
                    {n.result === 'failed' && <span className="ai-res">{t('실패')}</span>}
                    {n.missing && <span className="ai-res ai-res-missing">{t('없음')}</span>}
                    {n.result === 'declined' && <span className="ai-res">{t('거부')}</span>}
                    {n.result === 'running' && <span className="ai-res">…</span>}
                    {n.recs[0].snapshot && restored.has(n.recs[0].snapshot) && (
                      <span className="ai-res ai-res-restored">{t('되돌림')}</span>
                    )}
                  </button>
                )
              })}
            </div>
            </div>
          </div>
        </section>

        {node && (
        <aside className="ai-detail">
          <ResizeHandle pref="aiDetailWidth" label={t('상세 패널 너비')} axis="x" />
          <button
            className="ghost icon-btn ai-detail-close"
            onClick={() => setNodeID(null)}
            title={t('닫기 (Esc)')}
            aria-label={t('닫기')}
          >
            ×
          </button>
          {node ? (
            <NodeDetail
              key={node.id}
              node={node}
              hostName={hostName}
              onOpenFold={(f) => setOpen((s) => new Set(s).add(f))}
              onError={onError}
              onOpenMCP={onOpenMCP}
            />
          ) : null}
        </aside>
        )}
      </div>
    </div>
  )
}

function nodeLabel(n: GraphNode): string {
  if (n.kind === 'reads') return t('조회 {n}건', { n: n.recs.length })
  if (n.kind === 'group') return `${n.recs[0].target || n.recs[0].tool} ×${n.recs.length}`
  return n.label || t(KIND_LABEL[n.kind] ?? '')
}

function nodeTitle(n: GraphNode): string {
  const r = n.recs[0]
  return `${t(KIND_LABEL[n.kind] ?? '')} · ${r.target || r.tool} · ${clock(r.at, true)}`
}

function SessionBar({
  session,
  hostName,
  onError,
}: {
  session: Session
  hostName: (id: string) => string
  onError: (msg: string) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<AIRevertReport | null>(null)
  useEffect(() => {
    setConfirm(false)
    setReport(null)
  }, [session.id])

  const files = session.changes - session.irreversible
  const run = async () => {
    setBusy(true)
    try {
      setReport(await AIRevertSession(session.id))
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <div className="ai-sessbar">
      <div className="ai-sessbar-title">
        <b>{clientName(session)}</b>
        <span className="muted small mono">
          {shortStamp(session.start, true)} – {clock(session.end, true)}
        </span>
      </div>
      {session.irreversible > 0 && (
        <span className="badge warn" title={t(STATE_NOTE.irreversible)}>
          {t('되돌릴 수 없는 작업 {n}건 포함', { n: session.irreversible })}
        </span>
      )}
      <span className="spacer" />
      {files > 0 &&
        !session.id.endsWith(':none') &&
        (confirm ? (
          <span className="ai-confirm">
            <span className="small">{t('이 세션의 파일 변경을 최신 것부터 되돌립니다.')}</span>
            <button className="danger small-btn" disabled={busy} onClick={() => void run()}>
              {t('되돌리기')}
            </button>
            <button className="ghost small-btn" disabled={busy} onClick={() => setConfirm(false)}>
              {t('취소')}
            </button>
          </span>
        ) : (
          <button className="ghost small-btn" onClick={() => setConfirm(true)}>
            {t('이 세션의 파일 변경 전부 되돌리기')}
          </button>
        ))}
      {report && (
        <div className="ai-report small">
          <span>{t('되돌림 {n}건', { n: report.reverted.length })}</span>
          {report.skipped.length > 0 && (
            <>
              <span>· {t('건너뜀 {n}건', { n: report.skipped.length })}</span>
              <ul>
                {report.skipped.map((s, i) => (
                  <li key={i} className="mono">
                    {hostName(s.hostId)}:{s.path} — {t(SKIP_REASON[s.reason] ?? s.reason)}
                    {s.error ? ` (${s.error})` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {report.irreversible > 0 && (
            <span>· {t('되돌릴 수 없는 작업 {n}건은 그대로입니다', { n: report.irreversible })}</span>
          )}
          <button className="ghost small-btn" onClick={() => setReport(null)}>
            {t('닫기')}
          </button>
        </div>
      )}
    </div>
  )
}

function NodeDetail({
  node,
  hostName,
  onOpenFold,
  onError,
  onOpenMCP,
}: {
  node: GraphNode
  hostName: (id: string) => string
  onOpenFold: (fold: string) => void
  onError: (msg: string) => void
  onOpenMCP: () => void
}) {
  if (node.kind === 'reads' || node.kind === 'group') {
    return (
      <div className="ai-detail-body">
        <h4>{node.kind === 'reads' ? t('조회 {n}건', { n: node.recs.length }) : t(KIND_LABEL.group)}</h4>
        <div className="muted small">{hostName(node.host)}</div>
        {node.fold && (
          <button className="ghost small-btn" onClick={() => onOpenFold(node.fold!)}>
            {t('펼치기')}
          </button>
        )}
        <ul className="ai-reads">
          {node.recs.map((r) => (
            <li key={r.id}>
              <span className="mono muted">{clock(r.at, true)}</span> <span className="mono">{r.tool}</span>{' '}
              <span className="mono ellipsis">{r.target}</span>
              {r.result !== 'ok' && <span className="badge danger">{t('실패')}</span>}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return <RecordDetail rec={node.recs[0]} hostName={hostName} onError={onError} onOpenMCP={onOpenMCP} />
}

// Refusals that come from a switch in LiteDeck rather than from the server.
// The error text is written for the model; the person reading the graph wants
// to know which switch, and where it is.
const REFUSALS: [RegExp, string][] = [
  [/deleting files is switched off/, k('이 서버는 AI의 파일 삭제가 꺼져 있어 LiteDeck이 거부했습니다. MCP 연동 › 권한에서 서버별로 「파일 삭제 허용」을 켭니다.')],
  [/running commands is switched off/, k('이 서버는 AI의 명령 실행이 꺼져 있어 LiteDeck이 거부했습니다. MCP 연동 › 권한에서 서버별로 「명령 실행 허용」을 켭니다.')],
  [/has not been shared with AI clients/, k('이 서버는 AI에 공유되지 않아 LiteDeck이 거부했습니다. MCP 연동 › 권한에서 서버를 켭니다.')],
]

function RecordDetail({
  rec,
  hostName,
  onError,
  onOpenMCP,
}: {
  rec: AIRecord
  hostName: (id: string) => string
  onError: (msg: string) => void
  onOpenMCP: () => void
}) {
  const refusal = rec.error ? REFUSALS.find(([re]) => re.test(rec.error!))?.[1] : undefined
  const isFile = rec.kind === 'file_write' || rec.kind === 'file_delete'
  const [view, setView] = useState<AIChangeView | null>(null)
  const [checking, setChecking] = useState(false)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)

  const check = async () => {
    if (!isFile) return
    setChecking(true)
    try {
      setView(await AIChange(rec.id))
    } catch (e) {
      onError(String(e))
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id, rec.result])

  const revert = async (withForce: boolean) => {
    setBusy(true)
    try {
      const res = await AIRevert(rec.id, withForce)
      if (!res.ok && res.error) onError(res.error)
      setForce(false)
      await check()
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const state = isFile ? view?.state : rec.result === 'ok' && rec.kind !== 'read' ? 'irreversible' : null
  return (
    <div className="ai-detail-body">
      <h4>{t(KIND_LABEL[rec.kind] ?? rec.kind)}</h4>
      <div className="mono ai-target selectable">{rec.target || rec.tool}</div>
      <div className="ai-facts small">
        <span>{hostName(rec.hostId || '')}</span>
        <span className="mono">{shortStamp(rec.at, true)}</span>
        <span className="mono">{rec.tool}</span>
        {rec.result === 'ok' && <span className="badge ok">{t('성공')}</span>}
        {isMissing(rec) && <span className="badge">{t('없음')}</span>}
        {rec.result === 'failed' && !isMissing(rec) && (
          <span className="badge danger">
            {t('실패')}
            {rec.exit != null ? ` · exit ${rec.exit}` : ''}
          </span>
        )}
        {rec.result === 'declined' && (
          <span className="badge warn">{rec.approval === 'timeout' ? t('응답 없음') : t('거부')}</span>
        )}
        {rec.result === 'running' && <span className="badge">{t('실행 중')}</span>}
        {rec.approval && rec.result === 'ok' && (
          <span className="muted">{rec.approval === 'approved' ? t('승인됨') : t('자동 승인')}</span>
        )}
      </div>

      {state && (
        <div className="ai-state" data-state={state}>
          <span className="badge" data-state={state}>
            {checking ? t('확인 중…') : t(STATE_LABEL[state] ?? state)}
          </span>
          {!checking && <p className="muted small">{t(STATE_NOTE[state] ?? '')}</p>}
          {view?.error && <p className="muted small mono">{view.error}</p>}
        </div>
      )}

      {isFile && view?.state === 'revertible' && (
        <button className="primary small-btn" disabled={busy} onClick={() => void revert(false)}>
          {t('이 변경 되돌리기')}
        </button>
      )}
      {isFile &&
        view?.state === 'changed' &&
        (force ? (
          <span className="ai-confirm">
            <button className="danger small-btn" disabled={busy} onClick={() => void revert(true)}>
              {t('그래도 되돌리기')}
            </button>
            <button className="ghost small-btn" onClick={() => setForce(false)}>
              {t('취소')}
            </button>
          </span>
        ) : (
          <button className="ghost small-btn" disabled={busy} onClick={() => setForce(true)}>
            {t('그래도 되돌리기…')}
          </button>
        ))}
      {isFile && view?.state === 'offline' && (
        <button className="ghost small-btn" disabled={checking} onClick={() => void check()}>
          {t('다시 확인')}
        </button>
      )}

      {isFile && view?.hasDiff && (
        <div className="ai-diff">
          <DiffView past path={view.path || rec.target || ''} before={view.before ?? ''} after={view.after ?? ''} />
        </div>
      )}

      {(rec.command || rec.kind === 'command') && (
        <>
          <h5>{t('명령')}</h5>
          <pre className="mono ai-pre selectable">{rec.command || rec.target}</pre>
        </>
      )}
      {isMissing(rec) && (
        <p className="muted small">
          {t('조회한 경로가 서버에 없습니다. 오류가 아니라 조회 결과입니다 — 지운 뒤 확인했다면 지워졌다는 뜻입니다.')}
        </p>
      )}
      {refusal && (
        <div className="ai-refusal">
          <p className="small">{t(refusal)}</p>
          <button className="ghost small-btn" onClick={onOpenMCP}>
            {t('MCP 연동 설정')}
          </button>
        </div>
      )}
      {rec.error && (
        <>
          <h5>{refusal ? t('AI에게 돌려준 메시지') : isMissing(rec) ? t('서버의 응답') : t('오류')}</h5>
          <pre className="mono ai-pre selectable">{rec.error}</pre>
        </>
      )}
      {rec.output && (
        <>
          <h5>{t('출력 (앞부분)')}</h5>
          <pre className="mono ai-pre selectable">{rec.output}</pre>
        </>
      )}
    </div>
  )
}
