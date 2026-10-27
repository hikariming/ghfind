/** Regenerates expected values in the shared TS/Go/Python co-creator fixtures. */
import fs from 'node:fs';
import {coCreatorShare,weightedCoreChurn,summarizeContributors} from '../../src/lib/co-creator';
const p='src/lib/__tests__/co-creator-fixtures.json';
const cases=JSON.parse(fs.readFileSync(p,'utf8'));
for(const c of cases){c.share=coCreatorShare(c.facts);console.log(c.name.padEnd(52),c.share.toFixed(4));}
fs.writeFileSync(p,JSON.stringify(cases,null,2)+'\n');
const q='src/lib/__tests__/contribution-content-fixtures.json';
const fx=JSON.parse(fs.readFileSync(q,'utf8'));
for(const c of fx.churn){c.expected=weightedCoreChurn(c.files,c.repo);console.log(c.name,c.expected);}
for(const c of fx.contributors){c.expected=summarizeContributors(c.rows,c.login,{truncated:c.truncated,historyTotal:c.history_total,fallbackUserCommits:c.fallback_user_commits});console.log(c.name,c.expected);}
fs.writeFileSync(q,JSON.stringify(fx,null,2)+'\n');
