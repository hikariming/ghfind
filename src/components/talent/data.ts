export type Talent = {
  tags?: string[]; officialTags?: string[]; pinned?: boolean; cornerTag?: string;
  projects?: { name: string; url?: string; description: string; relationship: 'own' | 'pr'; contribution: string }[];
  sources?: { url?: string; title: string; publisher: string; kind: 'github' | 'article' | 'website'; description: string }[];
  publicFields?: Partial<Record<import('./intake').Field, string>>; pending?: boolean;
  id: string; name: string; handle: string; initials: string; color: string;
  role: string; location: string; direction: string; bio: string;
  skills: string[]; stars: number | null; contributions: number | null; source: string;
  score: number | null;
  project: string; projectDescription: string; note: string; available: boolean;
};
