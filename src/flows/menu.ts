/** A menu opened from a button, placed under it */
export type MenuAt = { id: string; top?: number; bottom?: number; left: number; anchor: HTMLElement } | null;

/** The menus these open are at most this tall */
const MENU_HEIGHT = 190;

export function menuAt(e: React.MouseEvent<HTMLElement>, id: string): MenuAt {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - 200);
  return r.bottom + 4 + MENU_HEIGHT > window.innerHeight
    ? { id, bottom: window.innerHeight - r.top + 4, left, anchor: e.currentTarget }
    : { id, top: r.bottom + 4, left, anchor: e.currentTarget };
}
