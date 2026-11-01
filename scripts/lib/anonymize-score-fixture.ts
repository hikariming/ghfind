/** Identity removal for mathematical regression snapshots, before persistence. */
export function anonymizeScoreFixture<T>(value: T, alias: string): T {
  if (!/^fixture-[a-z0-9-]+$/.test(alias)) throw new Error('A fixture-* alias is required');
  const identities = new Map<string,string>();
  const add=(value:string)=>{const key=value.toLowerCase();if(!identities.has(key))identities.set(key,`fixture-member-${identities.size+1}`);};
  const scan=(v:unknown,key=''):void=>{
    if(typeof v==='string' && /(repo|repos)$/.test(key) && /^[\w-]+\/[\w.-]+$/.test(v))add(v.split('/')[0]);
    if(typeof v==='string' && /^https:\/\/github\.com\/[^/]+/.test(v))add(new URL(v).pathname.split('/')[1]);
    if(Array.isArray(v)){v.forEach(x=>scan(x,key));return;}
    if(!v||typeof v!=='object')return;
    for(const [k,x] of Object.entries(v)){
      if(typeof x==='string'&&['username','login','owner_login','author'].includes(k))add(x);
      if(typeof x==='string'&&['repo','name_with_owner','best_original_repo_quality_repo','top_starred_original_repo_quality_repo'].includes(k)&&x.includes('/'))add(x.split('/')[0]);
      if(/^[\w-]+\/[\w.-]+$/.test(k))add(k.split('/')[0]);
      scan(x,k);
    }
  };
  scan(value);
  const root=value as {metrics?:{username?:string}};
  if(root.metrics?.username)identities.set(root.metrics.username.toLowerCase(),alias);
  const names=[...identities.keys()].sort((a,b)=>b.length-a.length).map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const identityPattern=names.length?new RegExp(`(?<![\\w])(?:${names.join('|')})(?![\\w])`,'gi'):null;
  const replace=(s:string):string=>identityPattern?s.replace(identityPattern,match=>identities.get(match.toLowerCase())!):s;
  const clean=(v:unknown,key=''):unknown=>{
    if(['avatar_url','profile_url','html_url'].includes(key))return 'https://example.com/fixture';
    if(['user_id','author_id','node_id'].includes(key))return null;
    if(['bio','company','description','readme_excerpt','prompt_summary'].includes(key))return null;
    if(typeof v==='string')return replace(v);
    if(Array.isArray(v))return v.map(x=>clean(x));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[replace(k), (k==='name'&&'username' in v)||(k==='id'&&typeof x==='number'&&('login' in v||'username' in v)) ? null : clean(x,k)]));
    return v;
  };
  return clean(value) as T;
}
