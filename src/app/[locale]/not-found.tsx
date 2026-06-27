import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("detail");
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-5 py-20 text-center">
      <h1 className="text-4xl font-black">404</h1>
      <Link
        href="/"
        className="mt-6 inline-block rounded-full bg-orange-600 px-5 py-2 text-sm font-medium text-white hover:bg-orange-500"
      >
        {t("selfCta")}
      </Link>
    </main>
  );
}
