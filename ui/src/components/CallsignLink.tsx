import { Link } from "react-router-dom";

interface CallsignLinkProps {
  callsign: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Renders a callsign as an internal link to /callsign/:callsign.
 */
export function CallsignLink({ callsign, className, children }: CallsignLinkProps) {
  return (
    <Link
      to={`/callsign/${callsign}`}
      className={className}
      onClick={(e) => e.stopPropagation()}
    >
      {children ?? callsign}
    </Link>
  );
}
