const TEMPLATE_LEAD =
  /^(?:[\w.@+/-]+(?:\/[\w.@+/-]+)?\s*)?(?:这是一个|这是一款|这是一种|这是|是一个|是一款|是一种|是面向|是|is an |is a |is the |is )/i;

const GENERIC_ONLY =
  /^(?:工具|项目|插件|扩展|库|框架|应用|平台|系统|沙盒|微服务|agent|skill|tool|project|plugin|extension|library|framework|app|platform|system|sandbox|microservice)s?[。.!！？]?$/i;

const WEAK_LEAD =
  /^(?:沙盒|微)?(?:工具|项目|插件|扩展|应用|库|框架|系统|平台|微服务|沙盒)(?:项目)?$/i;

/** Turn a stored summary into a hook. Drops "X is a Y" leads. Does not touch scores. */
export function discoverHook(input: {
  name: string;
  summary: string;
  pain?: string | null;
}): string {
  const pain = tidy(input.pain);
  if (pain && !isTemplate(pain, input.name) && !isGenericOnly(pain)) {
    return clip(pain, 180);
  }
  const stripped = tidy(stripTemplate(input.summary, input.name));
  if (stripped && !isGenericOnly(stripped)) return clip(stripped, 180);
  if (stripped) return clip(stripped, 180);
  return clip(tidy(input.summary), 180);
}

function tidy(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isTemplate(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  const nameLower = name.toLowerCase();
  return (
    TEMPLATE_LEAD.test(text) ||
    lower.startsWith(`${nameLower} 是`) ||
    lower.startsWith(`${nameLower} is`) ||
    /^这是一个|^这是一款|^这是一种/i.test(text)
  );
}

function isGenericOnly(text: string): boolean {
  return GENERIC_ONLY.test(text.trim());
}

function isWeakLead(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 10) return false;
  return isGenericOnly(t) || WEAK_LEAD.test(t);
}

function stripTemplate(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(
    `^${escaped}\\s*(?:这是一个|这是一款|这是一种|是一个|是一款|是一种|是面向|是|is an |is a |is the |is )`,
    "i",
  );
  const cut = text.replace(named, "").replace(TEMPLATE_LEAD, "");
  const sentence = (cut.split(/(?<=[。！？.!?])\s*/)[0] ?? cut).replace(/^[，,、:\s]+/, "").trim();
  const comma = sentence.search(/[，,]/);
  if (comma > 0 && isWeakLead(sentence.slice(0, comma))) {
    return sentence.slice(comma + 1).trim();
  }
  return sentence;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
