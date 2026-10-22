const TEMPLATE_LEAD = /^(?:[\w.@+-]+(?:\/[\w.@+-]+)?\s*)?(?:是一个|是一款|是一种|是面向|是|is an |is a |is the |is )/i;

/** Turn a stored summary into a hook. Drops the "X is a Y" lead. Does not touch scores. */
export function discoverHook(input: {
  name: string;
  summary: string;
  pain?: string | null;
}): string {
  const pain = tidy(input.pain);
  if (pain && !isTemplate(pain, input.name)) return clip(pain, 180);
  const stripped = tidy(stripTemplate(input.summary, input.name));
  if (stripped) return clip(stripped, 180);
  return clip(tidy(input.summary), 180);
}

function tidy(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isTemplate(text: string, name: string): boolean {
  return TEMPLATE_LEAD.test(text) || text.toLowerCase().startsWith(`${name.toLowerCase()} 是`) || text.toLowerCase().startsWith(`${name.toLowerCase()} is`);
}

function stripTemplate(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`^${escaped}\\s*(?:是一个|是一款|是一种|是面向|是|is an |is a |is )`, "i");
  const cut = text.replace(named, "").replace(TEMPLATE_LEAD, "");
  const sentence = cut.split(/(?<=[。！？.!?])\s*/)[0] ?? cut;
  return sentence.replace(/^[，,、:\s]+/, "");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
