import datetime, hashlib, json, os, pathlib, socket, subprocess, time, urllib.error, urllib.request
ROOT=pathlib.Path('/Users/asperformias/Code/github/ghfind-worktrees/go-feed-core')
OUT=pathlib.Path('/tmp/ghfind-feed-portability-a3c3f84')
SHA='a3c3f841c15a247d5a2b187aa0f6ac5fa5e1616e'
PG='ghfind-portability-a3-pg'; MINIO='ghfind-portability-a3-minio'; SOURCE='ghfind-portability-a3-source'; API='ghfind-portability-a3-api'; WORKER='ghfind-portability-a3-worker'
NETWORK='ghfind-portability-a3'; VOLUME='ghfind-portability-a3-pgdata'
IMAGE=(OUT/'image-id.txt').read_text().strip()
NAMES=[PG,MINIO,SOURCE,API,WORKER]
OWNED=[]; CREATED=set()
REPORT={'sourceSha':SHA,'imageId':IMAGE,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commands':[],'requests':[],'checks':{},'scope':'ordinary Docker synthetic fixture; source is health-only; no OAuth, assessment, queue, Cloudflare, capacity or production evidence'}
def save(): (OUT/'run.json').write_text(json.dumps(REPORT,indent=2)+'\n')
def run(args, env=None, required=True, timeout=60):
 at=datetime.datetime.now(datetime.timezone.utc).isoformat();start=time.monotonic(); p=subprocess.run(args,cwd=ROOT,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 REPORT['commands'].append({'at':at,'argv':args,'seconds':time.monotonic()-start,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr});save()
 if p.returncode==0 and args[:2]==['docker','run'] and '--name' in args:OWNED.append(args[args.index('--name')+1])
 if p.returncode==0 and args[:3]==['docker','network','create']:CREATED.add('network')
 if p.returncode==0 and args[:3]==['docker','volume','create']:CREATED.add('volume')
 if required and p.returncode:raise RuntimeError('command failed: '+str(args))
 return p

def sql(query):return run(['docker','exec',PG,'psql','-U','postgres','-d','feed_portability_test','-At','-c',query]).stdout.strip()
def request(label,origin,path,method='GET',body=None,headers=None):
 start=time.monotonic();req=urllib.request.Request(origin+path,data=body,method=method,headers=headers or {})
 try: response=urllib.request.urlopen(req,timeout=6)
 except urllib.error.HTTPError as e:response=e
 record={'label':label,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'origin':origin,'path':path,'method':method,'status':response.status,'headers':dict(response.headers),'body':response.read().decode(),'seconds':time.monotonic()-start};response.close();REPORT['requests'].append(record);save();return record

def wait_http(label,origin,path,expected):
 for i in range(20):
  try:
   r=request(label,origin,path)
   if r['status']==expected:return r
  except (OSError,urllib.error.URLError):pass
  time.sleep(.5)
 raise RuntimeError(label+' unavailable')

def check_response(r,status,service=None):
 assert r['status']==status,r
 assert r['headers'].get('Cache-Control')=='no-store',r
 if service:
  body=json.loads(r['body']);assert body['service']==service and body['version']==SHA and body['contractVersion']==1,r

def start_app(name,port,binary,extra):
 envs={'PORT':str(port),'FEED_MODE':'baseline','FEED_STORE_PROFILE':'postgres','FEED_WRITER_EPOCH':'1','FEED_DATABASE_URL':'postgres://postgres:portability-local-only@127.0.0.1:5432/feed_portability_test?sslmode=disable',**extra}
 args=['docker','run','-d','--name',name,'--platform','linux/amd64','--network','container:'+PG,'--read-only','--user','65532:65532','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','0.5','--memory','256m','--memory-swap','256m','--pids-limit','64','--ulimit','nofile=4096:4096','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777','--mount','type=bind,source='+str(OUT/'probe')+',target=/verify/probe,readonly','--entrypoint',binary]
 for k,v in envs.items():args+=['-e',k+'='+v]
 args+=[IMAGE];run(args)

try:
 assert run(['git','rev-parse','HEAD']).stdout.strip()==SHA
 assert run(['git','status','--porcelain']).stdout.strip()==''
 current=run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines();assert not set(current)&set(NAMES)
 assert VOLUME not in run(['docker','volume','ls','--format','{{.Name}}']).stdout.splitlines()
 assert NETWORK not in run(['docker','network','ls','--format','{{.Name}}']).stdout.splitlines()
 for port in [55445,59005,58085,58086]:
  with socket.socket() as s:s.bind(('127.0.0.1',port))
 run(['docker','network','create','--internal',NETWORK]);run(['docker','volume','create',VOLUME])
 run(['docker','run','-d','--name',PG,'--network',NETWORK,'--cpus','1','--memory','1g','--shm-size','128m','-e','POSTGRES_USER=postgres','-e','POSTGRES_PASSWORD=portability-local-only','-e','POSTGRES_DB=feed_portability_test','-p','127.0.0.1:55445:5432','-p','127.0.0.1:59005:9000','-p','127.0.0.1:58085:8080','-p','127.0.0.1:58086:8081','--mount','type=volume,source='+VOLUME+',target=/var/lib/postgresql/data','pgvector/pgvector@sha256:137f044b0efe3d57f39b972b9b53641b1f2045b99d879e298bbf514a25787dcf','postgres','-c','shared_buffers=128MB','-c','max_connections=40'])
 for i in range(30):
  if run(['docker','exec',PG,'pg_isready','-U','postgres','-d','feed_portability_test'],required=False).returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('postgres startup failed')
 sql('CREATE EXTENSION vector')
 env=dict(os.environ,FEED_DATABASE_URL='postgres://postgres:portability-local-only@127.0.0.1:55445/feed_portability_test?sslmode=disable')
 run(['go','run','./cmd/ghfind-feed-migrate'],env=env,timeout=120)
 REPORT['schema']=json.loads(sql("SELECT json_build_object('database',current_database(),'compatibility',(SELECT row_to_json(s) FROM feed.schema_compatibility s),'migrationCount',(SELECT count(*) FROM feed.schema_migrations),'projects',(SELECT count(*) FROM feed.projects),'users',(SELECT count(*) FROM feed.users),'jobs',(SELECT count(*) FROM feed.jobs))"));save()
 run(['docker','run','-d','--name',MINIO,'--network','container:'+PG,'--cpus','0.5','--memory','256m','--tmpfs','/data:size=16m','-e','MINIO_ROOT_USER=portability-local','-e','MINIO_ROOT_PASSWORD=portability-local-only-password','quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e','server','/data'])
 wait_http('minio-live','http://127.0.0.1:59005','/minio/health/live',200)
 run(['go','run',str(OUT/'bucket.go')],timeout=60)
 source_secret='portability-source-only-0123456789abcdef'
 run(['docker','run','-d','--name',SOURCE,'--platform','linux/amd64','--network','container:'+PG,'--read-only','--user','65532:65532','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','0.1','--memory','64m','--pids-limit','16','--mount','type=bind,source='+str(OUT/'probe')+',target=/verify/probe,readonly','-e','FIXTURE_SOURCE_SECRET='+source_secret,'--entrypoint','/verify/probe',IMAGE,'source'])
 start_app(API,8080,'/usr/local/bin/feed-api',{'FEED_GATEWAY_SECRET':'portability-gateway-only-0123456789abcdef','FEED_SIGNING_SECRET':'portability-signing-only-0123456789abcdef'})
 start_app(WORKER,8081,'/usr/local/bin/feed-worker',{'FEED_EXECUTOR_ENABLED':'true','FEED_EXECUTOR_SECRET':'portability-executor-only-0123456789abcdef','FEED_SOURCE_SECRET':source_secret,'FEED_SOURCE_ENDPOINT':'http://127.0.0.1:9090','FEED_ARCHIVE_S3_ENDPOINT':'http://127.0.0.1:9000','FEED_ARCHIVE_S3_REGION':'us-east-1','FEED_ARCHIVE_S3_BUCKET':'feed-portability-synthetic','FEED_ARCHIVE_S3_ACCESS_KEY_ID':'portability-local','FEED_ARCHIVE_S3_SECRET_ACCESS_KEY':'portability-local-only-password','FEED_ARCHIVE_S3_PATH_STYLE':'true'})
 for name,origin,service in [(API,'http://127.0.0.1:58085','feed-api'),(WORKER,'http://127.0.0.1:58086','feed-worker')]:
  check_response(wait_http('initial-ready-'+name,origin,'/readyz',200),200,service)
  check_response(request('health-'+name,origin,'/healthz'),200,service)
  REPORT['checks'][name+'-initial-probe']=json.loads(run(['docker','exec',name,'/verify/probe']).stdout)
 check_response(request('anonymous','http://127.0.0.1:58085','/api/feed/projects?limit=20'),401)
 check_response(request('cleanup-no-auth','http://127.0.0.1:58086','/internal/feed/jobs/cleanup','POST',b'{}',{'Content-Type':'application/json'}),401)
 idle=request('cleanup-idle','http://127.0.0.1:58086','/internal/feed/jobs/cleanup','POST',b'{}',{'Content-Type':'application/json','Authorization':'Bearer portability-executor-only-0123456789abcdef'});check_response(idle,200);assert json.loads(idle['body'])=={'status':'idle','steps':0,'processed':0},idle
 sql('UPDATE feed.schema_compatibility SET min_writer_contract=1,max_writer_contract=1 WHERE singleton=true')
 for origin,service in [('http://127.0.0.1:58085','feed-api'),('http://127.0.0.1:58086','feed-worker')]:check_response(request('writer1-incompatible',origin,'/readyz'),503,service)
 sql('UPDATE feed.schema_compatibility SET min_writer_contract=2,max_writer_contract=2 WHERE singleton=true')
 for origin,service in [('http://127.0.0.1:58085','feed-api'),('http://127.0.0.1:58086','feed-worker')]:check_response(request('writer2-restored',origin,'/readyz'),200,service)
 run(['docker','stop','--time','10',MINIO]);check_response(request('minio-down-worker','http://127.0.0.1:58086','/readyz'),503,'feed-worker');check_response(request('minio-down-api','http://127.0.0.1:58085','/readyz'),200,'feed-api');run(['docker','start',MINIO]);wait_http('minio-restored','http://127.0.0.1:59005','/minio/health/live',200)
 # MinIO tmpfs deliberately loses the empty test bucket on restart. Create it
 # again before expecting archive readiness; no original content is restored.
 run(['go','run',str(OUT/'bucket.go')],timeout=60);check_response(wait_http('worker-after-bucket-recreate','http://127.0.0.1:58086','/readyz',200),200,'feed-worker')
 for name,origin,service in [(API,'http://127.0.0.1:58085','feed-api'),(WORKER,'http://127.0.0.1:58086','feed-worker')]:
  run(['docker','stop','--time','30',name]);state=json.loads(run(['docker','inspect','--format','{{json .State}}',name]).stdout);REPORT['checks'][name+'-sigterm']=state;assert state['ExitCode']==0 and not state['OOMKilled'],state
  run(['docker','start',name]);check_response(wait_http('after-restart-'+name,origin,'/readyz',200),200,service)
  probe=json.loads(run(['docker','exec',name,'/verify/probe']).stdout);REPORT['checks'][name+'-after-restart-probe']=probe;assert not probe['markerExistedBefore'],probe
 REPORT['runtimeContainers']=[]
 for name in [API,WORKER]:
  c=json.loads(run(['docker','inspect',name]).stdout)[0];REPORT['runtimeContainers'].append({'name':name,'id':c['Id'],'image':c['Image'],'path':c['Path'],'user':c['Config']['User'],'readOnly':c['HostConfig']['ReadonlyRootfs'],'tmpfs':c['HostConfig']['Tmpfs'],'memoryBytes':c['HostConfig']['Memory'],'nanoCPUs':c['HostConfig']['NanoCpus'],'capDrop':c['HostConfig']['CapDrop'],'securityOpt':c['HostConfig']['SecurityOpt'],'pidsLimit':c['HostConfig']['PidsLimit']});assert c['Image']==IMAGE
 REPORT['finalFacts']=json.loads(sql("SELECT json_build_object('projects',(SELECT count(*) FROM feed.projects),'users',(SELECT count(*) FROM feed.users),'jobs',(SELECT count(*) FROM feed.jobs),'deletions',(SELECT count(*) FROM feed.user_deletion_tombstones),'writerContract',(SELECT min_writer_contract FROM feed.schema_compatibility WHERE singleton))"))
 REPORT['result']='passed_bounded_local_checks'
except BaseException as e:
 REPORT['result']='failed';REPORT['error']=repr(e);save();raise
finally:
 for name in OWNED:
  p=run(['docker','logs','--timestamps',name],required=False)
  (OUT/(name+'.log')).write_text(p.stdout+p.stderr)
 for name in reversed(OWNED):run(['docker','rm','-f','-v',name],required=False)
 if 'volume' in CREATED:run(['docker','volume','rm',VOLUME],required=False)
 if 'network' in CREATED:run(['docker','network','rm',NETWORK],required=False)
 current=run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines();volumes=run(['docker','volume','ls','--format','{{.Name}}']).stdout.splitlines();networks=run(['docker','network','ls','--format','{{.Name}}']).stdout.splitlines()
 REPORT['cleanup']={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'containersRemoved':not set(current)&set(NAMES),'volumeRemoved':VOLUME not in volumes,'networkRemoved':NETWORK not in networks,'otherGhfindContainers':[n for n in current if n.startswith('ghfind-')]};REPORT['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
print(json.dumps({'result':REPORT['result'],'checks':REPORT['checks'],'cleanup':REPORT['cleanup']},indent=2))
