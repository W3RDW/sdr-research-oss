import { Link } from "react-router-dom";

interface FrequencyLinkProps {
  hz: number;
  label?: string;
  className?: string;
}

/**
 * Renders a frequency as a link to /frequency/:hz.
 */
export function FrequencyLink({ hz, label, className }: FrequencyLinkProps) {
  const display = label ?? `${(hz / 1_000_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} MHz`;
  return (
    <Link
      to={`/frequency/${hz}`}
      className={className ?? "text-blue-600 hover:underline"}
      onClick={(e) => e.stopPropagation()}
    >
      {display}
    </Link>
  );
}
