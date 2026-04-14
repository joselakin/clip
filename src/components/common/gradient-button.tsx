import type { ButtonHTMLAttributes, ReactNode } from "react";

type GradientButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

export function GradientButton({
  children,
  className,
  type = "button",
  ...props
}: GradientButtonProps) {
  return (
    <button type={type} className={`${className ?? ""} transition-all active:scale-95`.trim()} {...props}>
      {children}
    </button>
  );
}
