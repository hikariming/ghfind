// Featured collections on the discover tab. Each maps to a directory filter so
// "view all" lands on the ordinary filtered grid with a shareable URL.
// `project` matches the GitHub owner of a talent's representative project.
export type TalentCollectionFilter = { tag: string } | { project: string };

export const TALENT_COLLECTIONS: { id: string; filter: TalentCollectionFilter }[] = [
  { id: 'dsh', filter: { tag: 'dsh内测用户' } },
  { id: 'vllm', filter: { project: 'vllm-project' } },
  { id: 'dify', filter: { project: 'langgenius' } },
  { id: 'lobehub', filter: { project: 'lobehub' } },
  { id: 'llamacpp', filter: { project: 'ggml-org' } },
  { id: 'sglang', filter: { project: 'sgl-project' } },
  { id: 'mcp', filter: { project: 'modelcontextprotocol' } },
  { id: 'langchain', filter: { project: 'langchain-ai' } },
];

export function collectionForProject(project: string) {
  return TALENT_COLLECTIONS.find(c => 'project' in c.filter && c.filter.project === project);
}
