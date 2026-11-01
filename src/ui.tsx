import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";

export const ICON = { size: 16, strokeWidth: 1.5, className: "icon" } as const;

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} strokeWidth={2} className="spinner" />;
}

/** Calls `onClose` on Escape or a pointer-down outside `ref` (and `except`). */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  open = true,
  except?: RefObject<HTMLElement | null>,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || except?.current?.contains(t)) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [ref, except, open]);
}

export type MenuEntry =
  | { label: string; icon?: LucideIcon; danger?: boolean; onSelect: () => void }
  | "separator";

export function Menu({
  entries,
  onClose,
  style,
  anchor,
}: {
  entries: MenuEntry[];
  onClose: () => void;
  style?: CSSProperties;
  anchor?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, true, anchor);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div ref={ref} className="popover menu" style={style} role="menu" onKeyDown={onKeyDown}>
      {entries.map((entry, i) =>
        entry === "separator" ? (
          <div key={i} className="menu__sep" />
        ) : (
          <button
            key={entry.label}
            className="menu__item"
            role="menuitem"
            data-danger={entry.danger || undefined}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon && <entry.icon {...ICON} />}
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}

export function LabelPill({ name, color, children }: { name: string; color?: string; children?: ReactNode }) {
  return (
    <span className="label" style={{ "--dot": color } as CSSProperties}>
      <span className="label__dot" />
      {name}
      {children}
    </span>
  );
}

export function Empty({
  icon: Icon,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty__icon">
        <Icon {...ICON} />
      </span>
      <div className="empty__title">{title}</div>
      {children && <div className="empty__body">{children}</div>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  );
}
