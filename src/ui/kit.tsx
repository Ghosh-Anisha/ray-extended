// The few Blade-shaped components the screens use (Button, Heading, Text,
// Alert), drawn with the section 2 tokens in globals.css. They take the same
// props the earlier screens passed to Blade, so a screen reads the same. Blade
// itself is a 1.6 MB script on every page; these are a few hundred bytes.
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = {
  variant?: "primary" | "secondary" | "tertiary";
  size?: "small" | "medium";
  isLoading?: boolean;
  isDisabled?: boolean;
  isFullWidth?: boolean;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "disabled" | "aria-busy" | "children">;

export function Button({ variant = "primary", size = "medium", isLoading, isDisabled, isFullWidth, children, type = "button", onClick, title, ...attributes }: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      className={`btn ${variant}${size === "small" ? " small" : ""}${isFullWidth ? " full" : ""}`}
      disabled={isDisabled || isLoading}
      aria-busy={isLoading || undefined}
      onClick={onClick}
      {...attributes}
    >
      {isLoading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Heading({ size = "large", children }: { size?: "small" | "medium" | "large"; children: ReactNode }) {
  const Tag = size === "large" ? "h1" : size === "medium" ? "h2" : "h3";
  return <Tag className={`heading ${size}`}>{children}</Tag>;
}

export function Text({ color, weight, children }: { color?: string; weight?: "regular" | "semibold"; children: ReactNode }) {
  const muted = color?.includes("muted");
  return <p className={`text${muted ? " muted" : ""}${weight === "semibold" ? " semibold" : ""}`}>{children}</p>;
}

export function Alert({ color = "information", description }: { color?: "negative" | "information" | "positive" | "notice"; description: string; isDismissible?: boolean }) {
  return (
    <div role="alert" className={`alert ${color}`}>
      {description}
    </div>
  );
}
