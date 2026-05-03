import { Link } from "react-router-dom";

interface TagLinkProps {
  tag: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Renders a tag as a link to /browse?tag=TAG.
 */
export function TagLink({ tag, className, children }: TagLinkProps) {
  return (
    <Link
      to={`/browse?tag=${encodeURIComponent(tag)}`}
      className={className ?? "inline-block bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded hover:bg-blue-200 transition-colors"}
      onClick={(e) => e.stopPropagation()}
    >
      {children ?? tag}
    </Link>
  );
}
