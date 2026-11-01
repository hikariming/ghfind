import { permanentRedirect } from "next/navigation";
import { localePath } from "@/lib/site";

export default async function BlogIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  permanentRedirect(localePath(locale, "/collections"));
}
