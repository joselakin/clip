import type { CSSProperties } from "react";

type MaterialIconProps = {
  name: string;
  className?: string;
  filled?: boolean;
  weight?: number;
};

export function MaterialIcon({
  name,
  className,
  filled = false,
  weight = 400,
}: MaterialIconProps) {
  const style: CSSProperties = {
    fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' ${weight}, 'GRAD' 0, 'opsz' 24`,
  };

  return (
    <span className={`material-symbols-outlined ${className ?? ""}`.trim()} style={style}>
      {name}
    </span>
  );
}
