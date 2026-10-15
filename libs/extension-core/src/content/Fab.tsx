import { Mascot, themeAppearance, type ThemeId } from '@adorable/graph-ui';

export function Fab({
  onClick,
  label,
  themeId,
}: {
  onClick: () => void;
  label: string;
  themeId: ThemeId;
}) {
  const appearance = themeAppearance(themeId);
  return (
    <button
      type="button"
      className="agg-fab"
      data-theme-id={themeId}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Mascot size={40} variant={appearance.mascot} color={appearance.mascotColor} />
      <span className="agg-fab-label">Git Graph</span>
    </button>
  );
}
