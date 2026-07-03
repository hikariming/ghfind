/**
 * Markdown `![alt](src "caption")` → a chart card. Article charts are static
 * SVGs authored on the site's dark palette, so the panel pins a dark
 * background instead of following the theme — on the light theme it reads as
 * an intentional "chart card", the same way code blocks do.
 */
export function Figure({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  return (
    <figure className="my-8">
      <div className="rounded-xl border border-[var(--border)] bg-[#0a0a0b] p-3 sm:p-5">
        {/* eslint-disable-next-line @next/next/no-img-element -- local static SVG; the image optimizer adds nothing */}
        <img src={src} alt={alt ?? ""} loading="lazy" className="mx-auto h-auto w-full" />
      </div>
      {(title ?? alt) && (
        <figcaption className="mt-2 text-center text-sm text-zinc-500">
          {title ?? alt}
        </figcaption>
      )}
    </figure>
  );
}
