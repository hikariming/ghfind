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
          className="rounded-full border border-orange-400/20 bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-200"
        >
          {productTagLabel(tag, locale)}
        </span>
      ))}
    </div>
  );
}
