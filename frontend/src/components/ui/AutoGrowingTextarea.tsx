import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export interface AutoGrowingTextareaProps {
  id?: string
  name?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  minRows?: number
  maxHeight?: number
  className?: string
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * Textarea that dynamically expands vertically as the user types longer content,
 * maintaining compact single-line height by default and scrolling if exceeding maxHeight.
 */
export default function AutoGrowingTextarea({
  id,
  name,
  value,
  onChange,
  placeholder,
  minRows = 1,
  maxHeight = 160,
  className = '',
  disabled = false,
  readOnly = false,
  ariaLabel,
  onKeyDown,
}: AutoGrowingTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const adjustHeight = useCallback(() => {
    const el = ref.current
    if (!el) return
    // Reset height to compute actual scrollHeight when content shrinks
    el.style.height = 'auto'
    const minHeight = Math.max(34, minRows * 20 + 14)
    const targetHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))
    el.style.height = `${targetHeight}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [maxHeight, minRows])

  useLayoutEffect(() => {
    adjustHeight()
  }, [value, adjustHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustHeight)
    return () => window.removeEventListener('resize', adjustHeight)
  }, [adjustHeight])

  return (
    <textarea
      ref={ref}
      id={id}
      name={name}
      rows={minRows}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      aria-label={ariaLabel}
      className={`field resize-none py-1.5 px-3 text-xs leading-relaxed transition-[height] duration-75 custom-scrollbar ${className}`}
    />
  )
}
