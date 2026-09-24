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

export default function WorkspacePage() {
  const [tab, setTab] = useState<TabKey>('mail')
  // GitHub is owned by a single org; others (e.g. Trijya) don't get it. Hide
  // the Code tab entirely for them. Starts hidden until confirmed to avoid a
  // show-then-remove flicker.
  const [githubEnabled, setGithubEnabled] = useState(false)
  // NAS (Files) is the inverse — only the org that owns the NAS (Trijya) gets
  // it. Hidden until confirmed.
  const [nasEnabled, setNasEnabled] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/github/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (alive) setGithubEnabled(!!j?.data?.enabled) })
      .catch(() => { if (alive) setGithubEnabled(false) })
    fetch('/api/nas/servers', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (alive) setNasEnabled(!!j?.data?.enabled) })
      .catch(() => { if (alive) setNasEnabled(false) })
    return () => { alive = false }
  }, [])

  const tabs = TABS.filter(
    (t) =>
      (t.key !== 'code' || githubEnabled) &&
      (t.key !== 'files' || nasEnabled) &&
      (t.key !== 'bylaws' || nasEnabled), // bylaws RAG is NAS-org-scoped, same gate as Files
  )

  // An invite link (?call=<room>) drops the user straight onto the Meet tab.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('call')) setTab('meet')
  }, [])

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
