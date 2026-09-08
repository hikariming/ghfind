import subprocess, json, time, urllib.request, urllib.error, concurrent.futures
from pathlib import Path
name='ghfind-feed-api-compatible'
image='ghfind-feed-local-contract:compatible'
version='0c23f3b'
base='http://127.0.0.1:58082'
def run(args,check=True):
    p=subprocess.run(args,capture_output=True,text=True)
    if check and p.returncode: raise RuntimeError(args[0]+' failed: '+p.stderr[:500])
    return p
existing=run(['docker','ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']).stdout.strip()
if existing: raise SystemExit('Probe container already exists; inspect before reuse')
result={'schemaVersion':1,'kind':'local-docker-portability-probe','version':version,'containerRootfsReadOnly':True,'applicationUser':'65532:65532','tmpfsBytes':1048576,'imageId':run(['docker','image','inspect',image,'--format','{{.Id}}']).stdout.strip(),'observations':[],'notProven':['Cloudflare Containers','real OAuth','real assessment','production rollout','load SLO','database migration or restore']}
def probe(path,expected):
    started=time.monotonic()
    try:
        response=urllib.request.urlopen(base+path,timeout=5)
    except urllib.error.HTTPError as e: response=e
    data=response.read().decode()
    if response.status!=expected: raise RuntimeError(path+' unexpected '+str(response.status)+': '+data[:200])
    if response.headers.get('Cache-Control')!='no-store': raise RuntimeError('cache policy missing')
    payload=json.loads(data)
    if path in ['/readyz','/healthz'] and payload.get('version')!=version: raise RuntimeError('version mismatch')
    observation={'path':path,'status':response.status,'durationMs':round((time.monotonic()-started)*1000,3),'response':payload}
    result['observations'].append(observation)
    return observation
try:
    run(['docker','run','-d','--name',name,'--platform','linux/amd64','--read-only','-v','/tmp/ghfind-ephemeral-probe:/opt/probe:ro','--tmpfs','/tmp:rw,noexec,nosuid,size=1m,mode=1777','--security-opt','no-new-privileges','--memory','256m','--cpus','1','-p','127.0.0.1:58082:8080','-e','FEED_MODE=baseline','-e','FEED_STORE_PROFILE=postgres','-e','FEED_DATABASE_URL=postgres://feed:feed-local-contract-only@host.docker.internal:55440/ghfind_docker_portability_test?sslmode=disable','-e','FEED_GATEWAY_SECRET=local-docker-only-gateway-secret-32bytes','-e','FEED_SIGNING_SECRET=local-docker-only-signing-secret-32bytes',image])
    for attempt in range(20):
        try: probe('/readyz',200); break
        except (urllib.error.URLError,ConnectionError): time.sleep(.25)
    else: raise RuntimeError('bounded readiness failed')
    probe('/healthz',200)
    probe('/api/feed/projects',401)
    marker=Path('/tmp/ghfind-container-ephemeral-marker');marker.write_text('disposable local probe\n')
    run(['docker','exec',name,'/opt/probe/bin','write'])
    run(['docker','exec',name,'/opt/probe/bin','present'])
    start=time.monotonic();run(['docker','stop','--time','30',name]);result['sigtermDurationMs']=round((time.monotonic()-start)*1000,3)
    state=json.loads(run(['docker','inspect',name,'--format','{{json .State}}']).stdout)
    if state['ExitCode']!=0 or state['OOMKilled']: raise RuntimeError('unclean termination')
    result['sigtermExitCode']=state['ExitCode']
    logs=run(['docker','logs',name]).stderr
    if 'draining Feed server' not in logs: raise RuntimeError('SIGTERM drain log absent')
    run(['docker','start',name])
    for attempt in range(20):
        try: probe('/readyz',200); break
        except (urllib.error.URLError,ConnectionError): time.sleep(.25)
    else: raise RuntimeError('bounded restart failed')
    run(['docker','exec',name,'/opt/probe/bin','absent'])
    result['temporaryDiskCleared']=True
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _:probe('/readyz',200),range(12)))
    result['successful']=True
finally:
    result['observedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    Path('/tmp/ghfind-feed-docker-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
