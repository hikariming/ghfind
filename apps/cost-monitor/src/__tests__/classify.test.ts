import {describe,it,expect} from 'vitest';
import {classify} from '../classify';
describe('alert classification',()=>{
 it.each([
 ['account:burn',1,0,'计费'],['Billing:account:daily',2,0,'计费'],
 ['Service:scan:errors',2,1,'评分'],['Service:card:errors',2,1,'卡片'],
 ['Service:roast:slow',2,2,'锐评'],['Service:roast:errors',1,2,'锐评'],
 ['Service:probe-home:errors',1,2,'可用性'],['Service:probe-home:errors',2,1,'可用性'],
 ['Workers:ghfind-api:errors',2,2,'线上API'],['Workers:fixture:errors',2,2,'Worker'],
 ['Monitor:heartbeat',2,1,'监控'],['Monitor:delivery',2,3,'监控'],['Deploy:main',2,3,'部署'],
 ] as const)('%s severity %s', (key,severity,priority,category)=>{expect(classify({key,severity})).toEqual({priority,category});});
});
