import { useCallback, useEffect, useState } from 'react'
import { Scrim } from './Scrim'
import {
  AddMCPClient,
  RemoveMCPClient,
  SetMCPRetention,
  MCPChanges,
  MCPState,
  RestoreMCPChange,
  PinMCPPort,
  RotateMCPToken,
  SetMCPEnabled,
  SetMCPHost,
  SetMCPHostDelete,
  SetMCPHostExec,
  SetMCPWritePolicy,
  type HostView,
  type MCPChange,
  type MCPStatus,
} from './ipc'
import { t } from './i18n'

// The MCP integration's settings.
//
// Called MCP rather than "AI" because the people who use it arrived from an MCP
// client and already know the word; "AI settings" would make them hunt for it.
//
// Three tabs rather than one column. The connection is set up once and then
// never touched; permissions are what somebody comes back to change; the change
// list is a record they read after the fact. Stacking all three made the one
// they wanted depend on how far they scrolled.

type Tab = 'connection' | 'permissions' | 'changes'

// Which client the paste line is written for.
//
// Two clients, two shapes, and the second cannot be derived from the first by
// hand: Claude Code takes the token as a header value, Codex takes the *name* of
// an environment variable holding it. Someone editing the Claude line into a
// Codex one registers a server that authenticates against the literal string
// "LITEDECK_MCP_TOKEN" and reads the failure as ours.
type Client = 'claude' | 'codex'

export function McpPanel({
  hosts,
  onClose,
  onError,
}: {
  hosts: HostView[]
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [tab, setTab] = useState<Tab>('connection')
  const [state, setState] = useState<MCPStatus | null>(null)
  const [changes, setChanges] = useState<MCPChange[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [client, setClient] = useState<Client>('claude')
  // Whose token is on screen: the default one, or a named client's.
  const [who, setWho] = useState<string>('default')
  const [adding, setAdding] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await MCPState())
    } catch (e) {
      onError(String(e))
    }
  }, [onError])

  const loadChanges = useCallback(async () => {
    try {
      setChanges((await MCPChanges('')) ?? [])
    } catch {
      // A record that will not load must not take the panel down with it.
    }
  }, [])

  useEffect(() => {
    void load()
    void loadChanges()
  }, [load, loadChanges])

  const apply = async (fn: () => Promise<MCPStatus>) => {
    setBusy(true)
    try {
      const next = await fn()
      setState(next)
      if (next.error) onError(next.error)
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const named = state?.clients?.find((c) => c.id === who)
  const token = named ? named.token : state?.token
  const snippet = named
    ? client === 'codex'
      ? named.codexSnippet
      : named.snippet
    : client === 'codex'
      ? state?.codexSnippet
      : state?.snippet

  const addClient = async () => {
    const label = (adding ?? '').trim()
    if (!label) return
    setBusy(true)
    try {
      const before = new Set((state?.clients ?? []).map((c) => c.id))
      const next = await AddMCPClient(label)
      setState(next)
      if (next.error) onError(next.error)
      else {
        const made = next.clients.find((c) => !before.has(c.id))
        if (made) setWho(made.id)
        setAdding(null)
        setReveal(true)
      }
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!snippet) return
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      onError(String(e))
    }
  }

  const shared = hosts.filter((h) => state?.hosts?.[h.id])

  return (
    <Scrim onClose={onClose}>
      <div className="dialog mcp-dialog">
        <h2>{t('MCP 연동')}</h2>
        <p className="muted small">
          {t(
            'Claude Code·Claude Desktop 같은 MCP 클라이언트가 이 앱을 통해 서버를 다룹니다. 같은 어댑터·SSH 연결·Command Log를 씁니다.',
          )}
        </p>

        <nav className="mcp-tabs">
          <button data-on={tab === 'connection' || undefined} onClick={() => setTab('connection')}>
            {t('연결')}
          </button>
          <button data-on={tab === 'permissions' || undefined} onClick={() => setTab('permissions')}>
            {t('권한')}
          </button>
          <button
            data-on={tab === 'changes' || undefined}
            onClick={() => {
              setTab('changes')
              void loadChanges()
            }}
          >
            {t('변경된 파일')}
            {changes.length > 0 && <span className="badge">{changes.length}</span>}
          </button>
        </nav>

        {tab === 'connection' && (
          <div className="mcp-tabbody">
            <label className="mcp-toggle">
              <input
                type="checkbox"
                disabled={busy}
                checked={!!state?.enabled}
                onChange={(e) => void apply(() => SetMCPEnabled(e.target.checked))}
              />
              <span>{t('로컬 MCP 엔드포인트 열기')}</span>
              {state?.running && <span className="badge ok">{t('실행 중')}</span>}
            </label>

            {state?.enabled && state.running && (
              <>
                <div className="mcp-endpoint">
                  <label className="muted small">{t('주소')}</label>
                  <code className="mono selectable">{state.url}</code>
                  <span className="muted small">
                    {t('127.0.0.1에만 열립니다. 외부 인터페이스로 여는 설정은 없습니다.')}
                  </span>
                  {/* The address moving is invisible from the client side — it
                      just stops connecting. Saying it here is the whole fix for
                      the half of #2 that was about not knowing. */}
                  {state.port && state.wantedPort && state.port !== state.wantedPort && (
                    <>
                      <span className="badge warn">
                        {t('{wanted} 번 포트가 사용 중이라 {got} 번으로 열렸습니다', {
                          wanted: state.wantedPort,
                          got: state.port,
                        })}
                      </span>
                      <span className="muted small">
                        {t('다음 실행에서 {wanted} 번이 비어 있으면 그쪽으로 돌아갑니다.', {
                          wanted: state.wantedPort,
                        })}
                      </span>
                      <div className="mcp-row">
                        <button
                          className="ghost small-btn"
                          disabled={busy}
                          onClick={() => void apply(() => PinMCPPort(state.port!))}
                          title={t('다음 실행부터 이 포트를 씁니다')}
                        >
                          {t('이 포트로 고정')}
                        </button>
                      </div>
                    </>
                  )}
                  {state.portPinned && (
                    <div className="mcp-row">
                      <span className="muted small">
                        {t('{port} 번 포트로 고정되어 있습니다.', { port: state.port ?? 0 })}
                      </span>
                      <button
                        className="ghost small-btn"
                        disabled={busy}
                        onClick={() => void apply(() => PinMCPPort(0))}
                      >
                        {t('고정 해제')}
                      </button>
                    </div>
                  )}
                </div>

                {/* One token per AI client, so the work graph can say which one
                    did something. Names are for the record only — every token
                    reaches exactly what the default one does. */}
                <div className="mcp-endpoint">
                  <label className="muted small">{t('AI 클라이언트')}</label>
                  <div className="mcp-clients mcp-client-list">
                    <button
                      data-on={who === 'default' || undefined}
                      onClick={() => {
                        setWho('default')
                        setCopied(false)
                      }}
                    >
                      {t('기본')}
                    </button>
                    {(state.clients ?? []).map((c) => (
                      <button
                        key={c.id}
                        data-on={who === c.id || undefined}
                        onClick={() => {
                          setWho(c.id)
                          setCopied(false)
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                    {adding === null ? (
                      <button className="mcp-client-add" onClick={() => setAdding('')}>
                        + {t('클라이언트 추가')}
                      </button>
                    ) : (
                      <form
                        className="mcp-client-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void addClient()
                        }}
                      >
                        <input
                          autoFocus
                          className="input"
                          value={adding}
                          maxLength={60}
                          placeholder={t('예: Claude Code - 맥북')}
                          onChange={(e) => setAdding(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation()
                              setAdding(null)
                            }
                          }}
                        />
                        <button className="primary small-btn" disabled={busy || !adding.trim()}>
                          {t('만들기')}
                        </button>
                      </form>
                    )}
                  </div>
                  <span className="muted small">
                    {t('클라이언트마다 토큰을 따로 주면 AI 작업 기록에 어느 쪽이 한 일인지 남습니다. 권한은 모두 같습니다.')}
                  </span>
                </div>

                <div className="mcp-endpoint">
                  <label className="muted small">{t('토큰')}</label>
                  <code className="mono selectable ellipsis">
                    {reveal ? token : '•'.repeat(24)}
                  </code>
                  <div className="mcp-row">
                    <button className="ghost small-btn" onClick={() => setReveal(!reveal)}>
                      {reveal ? t('가리기') : t('보기')}
                    </button>
                    {named ? (
                      <button
                        className="ghost small-btn"
                        disabled={busy}
                        onClick={() => {
                          setWho('default')
                          void apply(() => RemoveMCPClient(named.id))
                        }}
                        title={t('이 토큰은 바로 쓸 수 없게 됩니다')}
                      >
                        {t('클라이언트 삭제')}
                      </button>
                    ) : (
                      <button
                        className="ghost small-btn"
                        disabled={busy}
                        onClick={() => void apply(() => RotateMCPToken())}
                        title={t('새 토큰을 만들고 이전 토큰을 무효화합니다')}
                      >
                        {t('토큰 재발급')}
                      </button>
                    )}
                  </div>
                </div>

                <div className="mcp-endpoint">
                  <label className="muted small">{t('클라이언트에 붙여넣기')}</label>
                  {/* Product names, left untranslated on purpose: they are what
                      the user typed to get here. */}
                  <div className="mcp-clients">
                    <button
                      data-on={client === 'claude' || undefined}
                      onClick={() => {
                        setClient('claude')
                        setCopied(false)
                      }}
                    >
                      Claude Code
                    </button>
                    <button
                      data-on={client === 'codex' || undefined}
                      onClick={() => {
                        setClient('codex')
                        setCopied(false)
                      }}
                    >
                      Codex
                    </button>
                  </div>
                  <code className="mono mcp-snippet selectable">{snippet}</code>
                  <button className="primary small-btn" onClick={() => void copy()}>
                    {copied ? t('복사됨') : t('복사')}
                  </button>
                  {client === 'codex' && (
                    <span className="muted small">
                      {t(
                        'Codex는 토큰을 값이 아니라 환경변수 이름으로 받습니다. 두 줄을 함께 붙여넣으세요.',
                      )}
                    </span>
                  )}
                </div>

                {/* Learned the hard way: after updating LiteDeck the client keeps
                    serving the tool list it fetched when it connected, so a new
                    tool looks missing until it reconnects. */}
                <p className="muted small">
                  {t(
                    'LiteDeck을 업데이트한 뒤에는 MCP 클라이언트도 다시 시작하세요. 클라이언트는 접속할 때 받은 도구 목록을 계속 쓰기 때문에, 새로 생긴 도구가 없는 것처럼 보입니다.',
                  )}
                </p>
              </>
            )}
          </div>
        )}

        {tab === 'permissions' && (
          <div className="mcp-tabbody">
            {/* No preamble. Every toggle below starts off, and the dropdown
                says what each mode does — a paragraph restating that is read
                once, believed, and then in the way forever. Why the modes are
                shaped the way they are belongs in docs/mcp.md. */}
            {hosts.length === 0 && (
              <div className="placeholder small">{t('등록된 호스트가 없습니다.')}</div>
            )}

            {hosts.map((h) => {
              const on = !!state?.hosts?.[h.id]
              return (
                <div key={h.id} className="mcp-host">
                  <label className="mcp-toggle">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={on}
                      onChange={(e) => void apply(() => SetMCPHost(h.id, e.target.checked))}
                    />
                    <span>{h.name || h.hostname}</span>
                    <span className="muted small mono">
                      {h.user}@{h.hostname}
                    </span>
                  </label>

                  {on && (
                    <div className="mcp-host-opts">
                      <label className="muted small">{t('변경 승인')}</label>
                      <select
                        disabled={busy}
                        value={state?.write?.[h.id]?.mode ?? 'ask'}
                        onChange={(e) =>
                          void apply(() => SetMCPWritePolicy(h.id, e.target.value, 8 * 60))
                        }
                      >
                        <option value="strict">{t('전부 물어보기')}</option>
                        <option value="ask">{t('파일 변경만 물어보기')}</option>
                        <option value="bypass">{t('8시간 동안 묻지 않기')}</option>
                      </select>

                      {/* Separate from the approval mode on purpose: whether the
                          tool exists and whether using it interrupts you are
                          different questions. */}
                      <label className="mcp-toggle">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={!!state?.delete?.[h.id]}
                          onChange={(e) =>
                            void apply(() => SetMCPHostDelete(h.id, e.target.checked))
                          }
                        />
                        <span className="small">{t('파일 삭제 허용')}</span>
                      </label>

                      {/* Its own switch again, and not folded into the one
                          above: letting an agent clear a log file is not the
                          same decision as letting it run anything. What it does
                          not do is override the mode on the left — that answers
                          a different question, and an agent left to work
                          overnight that stops at the first command has not been
                          left anywhere. */}
                      <label className="mcp-toggle">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={!!state?.exec?.[h.id]}
                          onChange={(e) =>
                            void apply(() => SetMCPHostExec(h.id, e.target.checked))
                          }
                        />
                        <span className="small">{t('명령 실행 허용')}</span>
                      </label>
                    </div>
                  )}
                </div>
              )
            })}

            {shared.length > 0 && (
              <p className="muted small">{t('{n}대 공유 중', { n: shared.length })}</p>
            )}
          </div>
        )}

        {tab === 'changes' && (
          <div className="mcp-tabbody">
            {/* The two facts somebody looking at this list acts on: how long
                they have, and that nothing of this is on the server. Why the
                feature exists is not one of them. */}
            <p className="muted small">
              {t('변경 전후 내용을 이 컴퓨터에 {days}일 보관합니다. 서버에는 아무것도 남기지 않습니다.', {
                days: state?.keepDays ?? 7,
              })}
            </p>
            <div className="mcp-row mcp-retention">
              <label className="muted small">{t('보관 기간')}</label>
              <select
                disabled={busy || !state}
                value={state?.keepDays ?? 7}
                onChange={(e) =>
                  void apply(() => SetMCPRetention(Number(e.target.value), state?.keepMB ?? 256))
                }
              >
                {[1, 3, 7, 14, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    {t('{n}일', { n: d })}
                  </option>
                ))}
              </select>
              <label className="muted small">{t('최대 용량')}</label>
              <select
                disabled={busy || !state}
                value={state?.keepMB ?? 256}
                onChange={(e) =>
                  void apply(() => SetMCPRetention(state?.keepDays ?? 7, Number(e.target.value)))
                }
              >
                {[64, 256, 1024, 4096].map((mb) => (
                  <option key={mb} value={mb}>
                    {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                  </option>
                ))}
              </select>
            </div>
            {changes.length === 0 && (
              <div className="placeholder small">{t('아직 없습니다.')}</div>
            )}
            <div className="mcp-changes">
              {changes.map((c) => (
                <div key={c.id} className="mcp-change">
                  <span className="mono ellipsis" title={c.path}>
                    {c.path}
                  </span>
                  <span className="muted small">
                    {c.at} ·{' '}
                    {c.action === 'delete' ? t('삭제됨') : c.created ? t('생성됨') : t('덮어씀')}
                  </span>
                  <button
                    className="ghost small-btn"
                    disabled={busy || !c.undoable}
                    title={
                      c.undoable ? undefined : t('사본을 남기기에 너무 커서 되돌릴 수 없습니다')
                    }
                    onClick={() =>
                      void RestoreMCPChange(c.id)
                        .then((r) => {
                          if (!r.ok && r.error) onError(r.error)
                          return loadChanges()
                        })
                        .catch((e) => onError(String(e)))
                    }
                  >
                    {t('되돌리기')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button className="primary" onClick={onClose}>
            {t('닫기')}
          </button>
        </div>
      </div>
    </Scrim>
  )
}
