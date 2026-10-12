import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from './i18n'
import { en } from './locale-en'
import { matches, shortcutLabel } from './platform'

// The command palette (§5.3 of the next spec).
//
// One key, from anywhere — including from inside a terminal, which otherwise
// swallows every keystroke — and then type a few letters of what you want:
// another host, a new split, a theme. It is a second way in to things that
// already have a button, not a place where new things live: an action that only
// exists here is an action nobody finds.
//
// # Search in both languages
//
// Every entry is searchable by its Korean and its English name whatever the
// interface is set to. Somebody who learned the app in one language and
// switched keeps the words their fingers already know.

export interface PaletteItem {
  id: string
  /** The Korean source string, which is also the catalogue key. */
  label: string
  /** Shown on the right — a host's address, a shortcut. */
  hint?: string
  /** A label already in its final form, for things with no catalogue entry —
   *  a host's own name. */
  raw?: string
  /** Shown before the label to say what kind of thing it is. */
  group: string
  run: () => void
}

/** ⇧⌘P on macOS, Ctrl+Shift+P elsewhere — registered with the rest of the
 *  app's keys in platform.ts. */
export function isPaletteKey(e: KeyboardEvent): boolean {
  return matches(e, 'palette')
}

export function paletteKeyLabel(): string {
  return shortcutLabel('palette')
}

function haystack(it: PaletteItem): string {
  const name = it.raw ?? `${it.label} ${en[it.label] ?? ''}`
  return `${name} ${it.group} ${en[it.group] ?? ''} ${it.hint ?? ''}`.toLowerCase()
}

/** Every word typed has to appear somewhere; earlier and tighter matches first. */
function rank(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items
  const scored: { it: PaletteItem; score: number }[] = []
  for (const it of items) {
    const hay = haystack(it)
    let score = 0
    let ok = true
    for (const w of words) {
      const at = hay.indexOf(w)
      if (at < 0) {
        ok = false
        break
      }
      score += at
    }
    if (ok) scored.push({ it, score })
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.it)
}

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => rank(items, query), [items, query])

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (it: PaletteItem | undefined) => {
    if (!it) return
    onClose()
    // After the palette is gone, so whatever it opens gets the focus rather
    // than handing it back to an input that no longer exists.
    setTimeout(it.run, 0)
  }

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label={t('명령 팔레트')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          value={query}
          placeholder={t('명령 · 호스트 · 화면 검색')}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(shown[sel])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {shown.length === 0 && <div className="palette-empty muted small">{t('맞는 항목이 없습니다')}</div>}
          {shown.map((it, i) => (
            <button
              key={it.id}
              role="option"
              aria-selected={i === sel}
              data-sel={i === sel || undefined}
              className="palette-item"
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it)}
            >
              <span className="palette-group">{t(it.group)}</span>
              <span className="palette-label ellipsis">{it.raw ?? t(it.label)}</span>
              {it.hint && <span className="palette-hint mono">{it.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
