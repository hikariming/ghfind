// Top-level browse categories for the directory. `direction` is free text set
// per record (and has drifted: "基础设施" / "后端与基础设施" / "后端 / 基础设施"),
// so categories group the stored zh values. Anything unmapped lands in
// `other`, which keeps new directions visible until they are assigned here.
export const TALENT_CATEGORIES = [
  { id: 'agent', directions: ['Agent 与工作流'] },
  { id: 'ai', directions: ['AI 应用开发', 'AI / 机器学习', '模型与推理基础设施'] },
  { id: 'infra', directions: ['基础设施', '后端与基础设施', '后端 / 基础设施'] },
  { id: 'frontend', directions: ['前端与体验', '前端开发', '全栈开发'] },
  { id: 'tools', directions: ['开发者工具', '数据与检索'] },
  { id: 'other', directions: [] },
] as const;

export type TalentCategoryId = (typeof TALENT_CATEGORIES)[number]['id'];

export const MAPPED_DIRECTIONS: string[] = TALENT_CATEGORIES.flatMap(c => [...c.directions]);

export function isTalentCategory(value: unknown): value is TalentCategoryId {
  return TALENT_CATEGORIES.some(c => c.id === value);
}

export function categoryOf(direction: string): TalentCategoryId {
  return TALENT_CATEGORIES.find(c => (c.directions as readonly string[]).includes(direction))?.id ?? 'other';
}
