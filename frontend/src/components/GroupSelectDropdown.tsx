import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, LockKeyhole, Plus, Users } from 'lucide-react'
import type { Group } from '../types'
import { spaceName } from '../access'

export default function GroupSelectDropdown({
  groups,
  value,
  onChange,
  allowCreateGroup = false,
  newGroupName = '',
}: {
  groups: Group[]
  value: string
  onChange: (groupId: string) => void
  allowCreateGroup?: boolean
  newGroupName?: string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const isNew = value === '__new__'
  const selected = !isNew ? (groups.find(g => g.id === value) ?? groups[0]) : null

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="field flex items-center justify-between gap-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {isNew ? (
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
              <Plus size={13} />
            </span>
          ) : selected?.is_personal ? (
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
              <LockKeyhole size={13} />
            </span>
          ) : (
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
              <Users size={13} />
            </span>
          )}
          <span className="truncate font-medium text-slate-900 dark:text-zinc-100">
            {isNew
              ? (newGroupName.trim() ? `New group: ${newGroupName.trim()}` : '+ New team group…')
              : selected ? spaceName(selected) : 'Select a space'}
          </span>
          {isNew ? (
            <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-500/20">
              New group
            </span>
          ) : selected?.is_personal ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
              Private
            </span>
          ) : selected ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
              {selected.members.length} members
            </span>
          ) : null}
        </div>
        <ChevronDown size={16} className={`shrink-0 text-slate-400 dark:text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-60 animate-pop-in overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
          <div className="px-2 py-1 text-[11px] font-medium text-slate-400 dark:text-zinc-500">
            Choose destination space
          </div>
          <div className="space-y-1">
            {groups.map(group => {
              const isSelected = !isNew && group.id === selected?.id
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => {
                    onChange(group.id)
                    setIsOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                    isSelected
                      ? 'bg-brand-50 text-brand-900 dark:bg-brand-950/60 dark:text-brand-200'
                      : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {group.is_personal ? (
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                        <LockKeyhole size={13} />
                      </span>
                    ) : (
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                        <Users size={13} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{spaceName(group)}</span>
                        {group.is_personal && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                            Private space
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-slate-400 dark:text-zinc-500">
                        {group.description || (group.is_personal ? 'Only you can see this' : `${group.members.length} members`)}
                      </p>
                    </div>
                  </div>
                  {isSelected && <Check size={16} className="shrink-0 text-brand-600 dark:text-brand-400" />}
                </button>
              )
            })}

            {allowCreateGroup && (
              <>
                <div className="my-1 border-t border-slate-100 dark:border-zinc-800" />
                <button
                  type="button"
                  onClick={() => {
                    onChange('__new__')
                    setIsOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                    isNew
                      ? 'bg-brand-50 text-brand-900 dark:bg-brand-950/60 dark:text-brand-200'
                      : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                      isNew
                        ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/60 dark:text-brand-300'
                        : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}>
                      <Plus size={13} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-brand-700 dark:text-brand-300">+ New team group…</span>
                      </div>
                      <p className="truncate text-xs text-slate-400 dark:text-zinc-500">
                        Create a new group and add this prompt to it
                      </p>
                    </div>
                  </div>
                  {isNew && <Check size={16} className="shrink-0 text-brand-600 dark:text-brand-400" />}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
