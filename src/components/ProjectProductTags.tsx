import { productTagLabel, type ProductTag } from "@/lib/project-analysis-labels";

export function ProjectProductTags({
  tags,
  locale,
  className = "",
  compact = false,
}: {
  tags: ProductTag[];
  locale: string;
  className?: string;
  compact?: boolean;
}) {
  if (tags.length === 0) return null;

  if (compact) {
    const remaining = tags.slice(2).map((tag) => productTagLabel(tag, locale)).join(" · ");
    return (
      <div className={`flex min-w-0 flex-nowrap gap-2 ${className}`}>
        {tags.slice(0, 2).map((tag) => (
          <span key={tag.slug} title={productTagLabel(tag, locale)} className="min-w-0 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {productTagLabel(tag, locale)}
          </span>
        ))}
        {remaining && (
          <span title={remaining} aria-label={remaining} className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            +{tags.length - 2}
          </span>
        )}
      </div>
    );
  }

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
