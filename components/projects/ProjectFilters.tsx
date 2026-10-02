'use client'

import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Select from '@/components/ui/Select'

interface ProjectFiltersProps {
  search: string
  status: string
  priority: string
  sort: string
  total: number
  isAdmin: boolean
  onSearchChange: (v: string) => void
  onStatusChange: (v: string) => void
  onPriorityChange: (v: string) => void
  onSortChange: (v: string) => void
  onCreateClick: () => void
}

export default function ProjectFilters({
  search,
  status,
  priority,
  sort,
  total,
  isAdmin,
  onSearchChange,
  onStatusChange,
  onPriorityChange,
  onSortChange,
  onCreateClick,
}: ProjectFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-6 py-4 bg-surface-raised border-b border-border-default">
      {/* Search */}
      <div className="relative flex-1 min-w-[220px]">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-muted text-sm select-none pointer-events-none">
          ⌕
        </span>
        <Input
          type="text"
          aria-label="Search projects"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="SEARCH PROJECTS..."
          className="pl-8 pr-8 py-2 text-xs"
        />
        {search && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-muted hover:text-primary text-xs leading-none"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* Status filter */}
      <div className="relative w-[160px] shrink-0">
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          options={[
            { value: '', label: 'ALL STATUS' },
            { value: 'ACTIVE', label: 'ACTIVE' },
            { value: 'ON_HOLD', label: 'ON HOLD' },
            { value: 'COMPLETED', label: 'COMPLETED' },
            ...(isAdmin ? [{ value: 'ARCHIVED', label: 'ARCHIVED' }] : []),
          ]}
          className="text-xs"
        />
      </div>

      {/* Priority filter */}
      <div className="relative w-[160px] shrink-0">
        <Select
          aria-label="Filter by priority"
          value={priority}
          onChange={(e) => onPriorityChange(e.target.value)}
          options={[
            { value: '', label: 'ALL PRIORITY' },
            { value: 'LOW', label: 'LOW' },
            { value: 'MEDIUM', label: 'MEDIUM' },
            { value: 'HIGH', label: 'HIGH' },
            { value: 'CRITICAL', label: 'CRITICAL' },
          ]}
          className="text-xs"
        />
      </div>

      {/* Sort — values must match the ORDER_BY allowlist in app/api/projects/route.ts */}
      <div className="relative w-[170px] shrink-0">
        <Select
          aria-label="Sort projects"
          value={sort}
          onChange={(e) => onSortChange(e.target.value)}
          options={[
            { value: 'recent', label: 'NEWEST FIRST' },
            { value: 'client', label: 'CLIENT A–Z' },
            { value: 'name', label: 'NAME A–Z' },
            { value: 'deadline', label: 'DEADLINE' },
          ]}
          className="text-xs"
        />
      </div>

      {/* Right: count + create */}
      <div className="ml-auto flex items-center gap-4">
        <span className="font-mono text-xs text-muted tracking-widest whitespace-nowrap">
          [{total} PROJECTS]
        </span>
        {isAdmin && (
          <Button
            onClick={onCreateClick}
            size="sm"
            className="whitespace-nowrap"
          >
            + NEW PROJECT
          </Button>
        )}
      </div>
    </div>
  )
}
