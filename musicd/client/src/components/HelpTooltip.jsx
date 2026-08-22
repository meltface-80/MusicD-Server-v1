import React, { useState, useRef, useEffect } from 'react'
import { HelpCircle } from 'lucide-react'

/**
 * HelpTooltip — a `?` icon that opens a small popover with help text.
 *
 * Usage:
 *   <HelpTooltip>
 *     The chain uses the IR whose rate matches the source.
 *     Mono or stereo WAV, 16/24/32-bit, max 1 second.
 *   </HelpTooltip>
 *
 * Replaces in-page <div style={s.help}>...help text...</div> blocks
 * to reclaim vertical space (#v1.1.0.52). Tap the icon to toggle.
 * Tap outside or press Escape to dismiss. Designed to be unobtrusive
 * inline with section titles and labels.
 *
 * Behaviour notes:
 *  - Click toggles open/closed (better than hover on touch devices).
 *  - Click outside the popover closes it.
 *  - Popover positions below-and-right of the icon by default.
 *    If that overflows the viewport horizontally, it shifts left so
 *    the popover stays on screen on a 375px-wide phone. (No
 *    repositioning on vertical overflow — popovers are short.)
 *  - The icon itself is small (12-14px) and tertiary-coloured so it
 *    doesn't compete with the heading next to it.
 */
export default function HelpTooltip({ children, size = 14 }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const popoverRef = useRef(null)
  const [adjustedLeft, setAdjustedLeft] = useState(null)

  // Close on outside click / Escape key.
  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    const handleEsc = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('touchstart', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('touchstart', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  // After the popover renders, check if it's overflowing the right
  // edge of the viewport. If so, shift it left so it stays on screen.
  // Done in a layout effect-like pattern via setTimeout(0) so the
  // popover has actually rendered to measure.
  useEffect(() => {
    if (!open) {
      setAdjustedLeft(null)
      return
    }
    const id = setTimeout(() => {
      if (!popoverRef.current) return
      const rect = popoverRef.current.getBoundingClientRect()
      const overflow = rect.right - window.innerWidth + 8
      if (overflow > 0) {
        setAdjustedLeft(-overflow)
      }
    }, 0)
    return () => clearTimeout(id)
  }, [open])

  return (
    <span ref={wrapRef} style={s.wrap}>
      <button
        type="button"
        style={{ ...s.icon, ...(open ? s.iconOpen : {}) }}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        aria-label="Help"
        aria-expanded={open}
      >
        <HelpCircle size={size} strokeWidth={1.8} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          style={{ ...s.popover, ...(adjustedLeft !== null ? { left: adjustedLeft } : {}) }}
          role="tooltip"
        >
          {children}
        </div>
      )}
    </span>
  )
}

const s = {
  wrap: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    marginLeft: 6,
    verticalAlign: 'middle',
  },
  icon: {
    background: 'transparent',
    border: 'none',
    padding: 2,
    margin: 0,
    cursor: 'pointer',
    color: 'var(--text-tertiary)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    transition: 'color 0.15s',
  },
  iconOpen: {
    color: 'var(--accent)',
  },
  popover: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 6,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-bright)',
    borderRadius: 6,
    padding: '10px 12px',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    width: 280,
    maxWidth: 'calc(100vw - 24px)',
    zIndex: 1000,
    boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
    // Keep links readable inside the popover.
    fontWeight: 'normal',
    textAlign: 'left',
  },
}
