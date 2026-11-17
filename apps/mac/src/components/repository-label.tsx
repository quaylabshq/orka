export function RepositoryLabel({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span
      className="resource-repository"
      title={name}
      aria-label={`Repository: ${name}`}
    >
      <BookMarkedIcon size={14} aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}
import { BookMarkedIcon } from "lucide-react";
