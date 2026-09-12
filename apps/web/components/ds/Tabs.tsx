import { Icon, type IconName } from "./Icon";

export type TabItem = {
  value: string;
  label: string;
  icon?: IconName;
  count?: number;
};

export type TabsProps = {
  items: TabItem[];
  value?: string;
  onChange?: (value: string) => void;
  variant?: "underline" | "pills";
  className?: string;
};

/** Tabs: underlined (view navigation) or pills (local filter). */
export function Tabs({
  items = [],
  value,
  onChange,
  variant = "underline",
  className = "",
}: TabsProps) {
  return (
    <div
      role="tablist"
      className={`wc-tabs${variant === "pills" ? " wc-tabs--pills" : ""} ${className}`}
    >
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange?.(it.value)}
            className={`wc-tab${on ? " wc-tab--on" : ""}`}
          >
            {it.icon ? <Icon name={it.icon} size={14} /> : null}
            {it.label}
            {it.count != null ? <span className="wc-tab__n">{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
