import type { ReactNode } from 'react';

/** 標題列的圖示按鈕（title 與 aria-label 都是 label）。 */
export function IconButton({
  label,
  onClick,
  children,
  tone,
  busy,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tone?: 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`agg-btn${tone ? ` agg-btn--${tone}` : ''}${busy ? ' agg-btn--busy' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}
