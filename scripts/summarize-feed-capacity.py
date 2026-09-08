#!/usr/bin/env python3
"""Summarize an existing capacity run without invoking a server or changing data."""
import argparse, collections, datetime, gzip, hashlib, json, re, shutil
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--destination', required=True, type=Path)
args = parser.parse_args()
src, dst = args.source.resolve(), args.destination.resolve()
if src == dst:
    parser.error('source and destination must differ')
dst.mkdir(parents=True, exist_ok=True)
load = json.loads((src/'load.json').read_text())
observations = load.pop('observations')
resources = load.pop('resourceSamples')
if len(observations) != load['Completed'] or sum(o['status'] == 200 and not o.get('error') for o in observations) != load['Successful']:
    raise ValueError('original report counters do not match raw observations')
values = sorted(o['durationMs'] for o in observations if o['status'] > 0)
def percentiles(values):
    values = sorted(values)
    return {k:values[i] for k,i in {'p50':len(values)//2,'p95':len(values)*95//100,'p99':len(values)*99//100,'max':len(values)-1}.items()} if values else {}
load['httpLatencyMs'] = percentiles(values)
load['admittedLatencyMs'] = percentiles([o['durationMs'] for o in observations if o.get('error') != 'concurrency_limit'])
origin = datetime.datetime.fromisoformat(load['loadStartedAt'].replace('Z', '+00:00'))
last_offset = max(o['finishedOffsetMs'] for o in observations)
load['lastResponseAt'] = (origin + datetime.timedelta(milliseconds=last_offset)).isoformat()
load['lastDispatchAt'] = (origin + datetime.timedelta(milliseconds=max(o['startedOffsetMs'] for o in observations))).isoformat()
load['observedLoadWindowSeconds'] = last_offset / 1000
load['loadReportSha256'] = hashlib.sha256((src/'load.json').read_bytes()).hexdigest()
load['latencyDefinition'] = 'Sort actual HTTP-response durations; floor(n*p) zero-based index. Admission rejections remain errors, with no HTTP latency. admittedLatencyMs also includes transport failures. Original capitalized PxxMS fields include both zero-duration rejections and timed transport failures and are not the success-only percentile.'
load['responseCounts'] = dict(collections.Counter(str(o['status']) for o in observations))
load['errorCounts'] = dict(collections.Counter(o.get('error', '') for o in observations))
load['itemCounts'] = dict(collections.Counter(str(o['items']) for o in observations if o['status'] == 200))
load['arrivalLagMs'] = percentiles([o['startedOffsetMs']-o['scheduledOffsetMs'] for o in observations])
load['resourceSummary'] = {
    'samples':len(resources),
    'sampleDurationMs':percentiles([r['sampleDurationMs'] for r in resources]),
    'maxSampleGapMs':max((b['offsetMs']-a['offsetMs'] for a,b in zip(resources,resources[1:])), default=0),
    'observerErrors':dict(collections.Counter(r.get('error','') for r in resources)),
    'maxGoroutines':max(r['goroutines'] for r in resources),
    'maxHeapBytes':max(r['heapBytes'] for r in resources),
    'gcCountDelta':resources[-1]['gcCount']-resources[0]['gcCount'],
    'gcPauseDeltaMs':(resources[-1]['gcPauseTotalNs']-resources[0]['gcPauseTotalNs'])/1e6,
    'maxSampledGCPauseDeltaMs':max((b['gcPauseTotalNs']-a['gcPauseTotalNs'] for a,b in zip(resources,resources[1:])), default=0)/1e6,
    'maxUngrantedLocks':max((r.get('postgresql',{}).get('ungrantedLocks',0) for r in resources),default=0),
}
flagged = [dict(index=i, **o) for i,o in enumerate(observations) if o['status'] != 200 or o.get('error') or o['durationMs'] > 800]
groups = []
for o in sorted(flagged, key=lambda o:o['startedOffsetMs']):
    if not groups or o['startedOffsetMs']-groups[-1][-1]['startedOffsetMs'] > 1000:
        groups.append([])
    groups[-1].append(o)
clusters = []
for group in groups:
    start = min(o['startedOffsetMs'] for o in group)
    end = max(o['finishedOffsetMs'] for o in group)
    clusters.append({'startOffsetMs':start,'endOffsetMs':end,'observations':group,
        'resourceSamples':[r for r in resources if start-2000 <= r['offsetMs'] <= end+2000]})
load['flaggedObservationCounts'] = {'httpAbove800ms':sum(o['status']>0 and o['durationMs']>800 for o in observations), 'nonSuccess':sum(o['status']!=200 or bool(o.get('error')) for o in observations), 'clusters':len(clusters)}
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
docker = []
for line in (src/'external-resources.jsonl').read_text().splitlines():
    rec = json.loads(line)
    if rec['source'] == 'docker':
        try:
            payload = json.loads(ansi.sub('',rec['line']))
            docker.append(dict(at=rec['at'], **payload))
        except json.JSONDecodeError: pass
load['dockerStreamingSummary'] = {}
load['dockerStreamingScope'] = 'Samples whose observer UTC receipt timestamps fall within loadStartedAt and lastResponseAt; complete stream retained separately. Docker CPU samples are raw reported values, not proof of quota utilization.'
docker_window = [r for r in docker if origin <= datetime.datetime.fromisoformat(r['at']) <= origin+datetime.timedelta(milliseconds=last_offset)]
for name in sorted({r['Name'] for r in docker_window}):
    rows = [r for r in docker_window if r['Name']==name]
    cpu = [float(r['CPUPerc'].removesuffix('%')) for r in rows if r['CPUPerc'] != '--']
    load['dockerStreamingSummary'][name] = {'samples':len(rows),'cpuUnavailableSamples':len(rows)-len(cpu),'cpuPercent':percentiles(cpu), 'first':rows[0], 'last':rows[-1]}
(dst/'load-summary.json').write_text(json.dumps(load,indent=2)+'\n')
(dst/'latency-clusters.json').write_text(json.dumps(clusters,indent=2)+'\n')
def gz(name, raw):
    with (dst/name).open('wb') as f:
        with gzip.GzipFile(fileobj=f,mode='wb',mtime=0) as z:z.write(raw)
gz('load-original.json.gz', (src/'load.json').read_bytes())
gz('observations.json.gz',json.dumps(observations,separators=(',',':')).encode())
gz('resource-samples.json.gz',json.dumps(resources,separators=(',',':')).encode())
gz('docker-samples.json.gz',json.dumps(docker,separators=(',',':')).encode())
gz('external-resources.jsonl.gz',(src/'external-resources.jsonl').read_bytes())
for name in ['fixture.json','query-plans.json','environment.json','schema.json','delete.json','seed.log','load.log','delete.log','postgres-seed.log','postgres-load.log','cleanup.json','post-run-state.json']:
    if (src/name).exists():shutil.copyfile(src/name,dst/name)
print(json.dumps({k:v for k,v in load.items() if k not in ['pgDockerStats']},indent=2))
