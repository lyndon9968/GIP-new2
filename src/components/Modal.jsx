import { useEffect } from 'react'
import { usePageActivity } from '../lib/PageCache'

export default function Modal({ title, children, onClose, footer, wide = false }) {
  const active = usePageActivity()
  useEffect(() => {
    if (!active) return
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, active])

  if (!active) return null
  return (
    <div className="mask" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <h3>{title}</h3>
          <button className="x" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-b">{children}</div>
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title = '请确认', message, onConfirm, onClose, danger = false, busy = false }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : '确定'}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 14.5, lineHeight: 1.7 }}>{message}</div>
    </Modal>
  )
}
