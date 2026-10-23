'use client'

import { useEffect, useState, useCallback } from 'react'

export type ProjectTabId = 'overview' | 'tasklist' | 'tasks' | 'updates'

function parseHash(hash: string): ProjectTabId {
  const h = hash.replace(/^#/, '').toLowerCase()
  if (h === 'tasklist' || h === 'tasks' || h === 'updates') return h
  return 'overview'
}

export default function ProjectTabs() {
  const [active, setActive] = useState<ProjectTabId>('overview')

  const syncFromLocation = useCallback(() => {
    if (typeof window === 'undefined') return
    const h = window.location.hash
    setActive(parseHash(h || '#overview'))
  }, [])

  useEffect(() => {
    syncFromLocation()
    window.addEventListener('hashchange', syncFromLocation)
    return () => window.removeEventListener('hashchange', syncFromLocation)
  }, [syncFromLocation])

  function setTab(tab: ProjectTabId) {
    window.location.hash = `#${tab}`
  }

  const tabs: { id: ProjectTabId; label: string }[] = [
    { id: 'overview', label: 'OVERVIEW' },
    { id: 'tasklist', label: 'TASK LIST' },
    { id: 'tasks', label: 'TASKS' },
    { id: 'updates', label: 'UPDATES' },
  ]

  return (
    <div className="flex">
      {tabs.map((t) => {
        const isActive = active === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-6 py-3 font-mono text-xs tracking-[0.2em] uppercase cursor-pointer border-b-2 transition-colors duration-150 ${
              isActive
                ? 'text-primary border-accent'
                : 'text-muted border-transparent hover:text-secondary'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export function useProjectTab(): ProjectTabId {
  const [tab, setTab] = useState<ProjectTabId>('overview')

  useEffect(() => {
    function read() {
      if (typeof window === 'undefined') return
      setTab(parseHash(window.location.hash || '#overview'))
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  return tab
}
