import { github, record } from "./github";

/** Current repository labels, minus the bot-owned review: set. */
export async function repoLabels(api: ReturnType<typeof github>, fullName: string) {
  const labels: { name: string; color: string; description: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const list = await api(
      `/repos/${fullName}/labels?per_page=100&page=${page}`,
    );
    if (!Array.isArray(list)) throw new Error("Invalid labels");
    for (const item of list) {
      const x = record(item);
      if (
        typeof x.name !== "string" ||
        x.name.toLowerCase().startsWith("review:")
      )
        continue;
      labels.push({
        name: x.name,
        // Only a validated hex value ever reaches a style attribute.
        color:
          typeof x.color === "string" && /^[0-9a-f]{6}$/i.test(x.color)
            ? x.color
            : "",
        description: typeof x.description === "string" ? x.description : "",
      });
    }
    if (list.length < 100) break;
  }
  return labels;
}
