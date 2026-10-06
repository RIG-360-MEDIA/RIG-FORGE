'use client'

import { useEffect, useState } from 'react'

import MailPanel from '@/components/workspace/MailPanel'
import CodePanel from '@/components/workspace/CodePanel'
import MeetPanel from '@/components/workspace/MeetPanel'
import DrivePanel from '@/components/workspace/DrivePanel'
import ContactsPanel from '@/components/workspace/ContactsPanel'
import FilesPanel from '@/components/workspace/FilesPanel'
import BylawsPanel from '@/components/workspace/BylawsPanel'

const TABS = [
  { key: 'mail', label: '📬 Mail' },
  { key: 'code', label: '⌥ Code' },
  { key: 'meet', label: '📹 Meet' },
  { key: 'drive', label: '📁 Drive' },
  { key: 'files', label: '🗄️ Files' },
  { key: 'bylaws', label: '📜 Bylaws' },
  { key: 'contacts', label: '👥 Contacts' },
] as const

type TabKey = (typeof TABS)[number]['key']
const isTabKey = (v: string | null): v is TabKey => TABS.some((t) => t.key === v)

/** The open tab lives in the URL (?tab=files), so Back from elsewhere, a
 * refresh, or a link returns to the same tab instead of always Mail. Clicking
 * a tab adds a history entry, so Back returns to exactly where the user was
 * (e.g. the Files folder they left); automatic corrections replace instead.
 * The Files panel's own ?server / ?path go when another tab is chosen. */
function urlForTab(key: TabKey): string {
  const u = new URL(window.location.href)
  u.searchParams.set('tab', key)
  if (key !== 'files') { u.searchParams.delete('server'); u.searchParams.delete('path') }
  return u.pathname + u.search + u.hash
}

export default function WorkspacePage() {
  const [tab, setTabState] = useState<TabKey>('mail')
  const setTab = (key: TabKey, opts: { replace?: boolean } = {}) => {
    setTabState(key)
    if (opts.replace) window.history.replaceState({ ...(window.history.state ?? {}) }, '', urlForTab(key))
    else if (key !== tab) window.history.pushState({}, '', urlForTab(key))
  }
  // GitHub is owned by a single org; others (e.g. Trijya) don't get it. Hide
  // the Code tab entirely for them. Starts hidden until confirmed to avoid a
  // show-then-remove flicker.
  const [githubEnabled, setGithubEnabled] = useState(false)
  // NAS (Files) is the inverse — only the org that owns the NAS (Trijya) gets
  // it. Hidden until confirmed.
  const [nasEnabled, setNasEnabled] = useState(false)
  const [githubChecked, setGithubChecked] = useState(false)
  const [nasChecked, setNasChecked] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/github/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (alive) setGithubEnabled(!!j?.data?.enabled) })
      .catch(() => { if (alive) setGithubEnabled(false) })
      .finally(() => { if (alive) setGithubChecked(true) })
    fetch('/api/nas/servers', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (alive) setNasEnabled(!!j?.data?.enabled) })
      .catch(() => { if (alive) setNasEnabled(false) })
      .finally(() => { if (alive) setNasChecked(true) })
    return () => { alive = false }
  }, [])

  const tabs = TABS.filter(
    (t) =>
      (t.key !== 'code' || githubEnabled) &&
      (t.key !== 'files' || nasEnabled) &&
      (t.key !== 'bylaws' || nasEnabled), // bylaws RAG is NAS-org-scoped, same gate as Files
  )

  // An invite link (?call=<room>) drops the user straight onto the Meet tab;
  // otherwise open the tab named in the URL. Back/Forward across Files folder
  // entries keep the Files tab; an entry from another tab restores that tab.
  useEffect(() => {
    const fromUrl = () => {
      const qs = new URLSearchParams(window.location.search)
      if (qs.get('call')) return 'meet' as const
      const t = qs.get('tab')
      return isTabKey(t) ? t : null
    }
    const initial = fromUrl()
    if (initial) setTabState(initial)
    const onPop = () => { const t = fromUrl(); setTabState(t ?? 'mail') }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A tab the user cannot see (e.g. ?tab=files for a company without the NAS,
  // once that is known) falls back to Mail instead of an empty panel.
  useEffect(() => {
    if ((tab === 'code' && githubChecked && !githubEnabled) || ((tab === 'files' || tab === 'bylaws') && nasChecked && !nasEnabled)) {
      setTab('mail', { replace: true })
    }
  }, [tab, githubEnabled, nasEnabled, githubChecked, nasChecked])

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <h1 className="font-mono text-xs uppercase tracking-widest text-text-secondary mb-3">Workspace</h1>
      <div className="flex gap-1 mb-4 border-b border-border-default">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-mono -mb-px border-b-2 transition-colors ${
              tab === t.key ? 'border-accent-ink text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'mail' && <MailPanel />}
      {tab === 'code' && <CodePanel />}
      {tab === 'meet' && <MeetPanel />}
      {tab === 'drive' && <DrivePanel />}
      {tab === 'files' && <FilesPanel />}
      {tab === 'bylaws' && <BylawsPanel />}
      {tab === 'contacts' && <ContactsPanel />}
    </div>
  )
}
