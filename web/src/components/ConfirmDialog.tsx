import { useEffect } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive rather than the default accent. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * An in-app substitute for window.confirm(). Some embedding hosts (VS Code's
 * webview among them) render the browser's native confirm dialog but never
 * deliver clicks to it, so OK becomes permanently unresponsive. Real DOM
 * buttons never have that problem.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
        </header>
        <div className="body">
          <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{message}</p>
        </div>
        <footer>
          <button onClick={onCancel}>{cancelLabel}</button>
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
