import { productTagLabel, type ProductTag } from "@/lib/project-analysis-labels";

export function ProjectProductTags({
  tags,
  locale,
  className = "",
}: {
  tags: ProductTag[];
  locale: string;
  className?: string;
}) {
  if (tags.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {tags.map((tag) => (
        <span
          key={tag.slug}
          className="rounded-md bg-muted px-2 py-1 text-xs font-normal text-muted-foreground"
        >
          {productTagLabel(tag, locale)}
        </span>
      ))}
    </div>
  );
}
