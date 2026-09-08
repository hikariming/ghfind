#!/usr/bin/env python3
"""Bounded, opt-in ordinary Docker Feed API contract. Default is a no-action plan."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import sys
import time
import uuid

PG_IMAGE = 'pgvector/pgvector@sha256:137f044b0efe3d57f39b972b9b53641b1f2045b99d879e298bbf514a25787dcf'
OWNER_LABEL = 'io.ghfind.fixture.owner'
SHA_LABEL = 'io.ghfind.fixture.source'
DB_NAME = 'feed_portability_test'
PG_PORT, API_PORT = 55446, 58087
GATEWAY = 'g' * 32  # Public synthetic fixture values, never production credentials.
SIGNING = 's' * 32
DB_PASSWORD = 'portability-local-only'
SCOPE = 'ordinary Docker real API HTTP; synthetic signing and direct projections, no OAuth/source queue/worker/S3/capacity/production acceptance'


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate_options(sha, directory, root):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('exact lowercase 40-hex source SHA required')
    root = root.resolve()
    out = pathlib.Path(directory)
    if not out.is_absolute() or root == out.resolve() or root in out.resolve().parents:
        raise ValueError('fresh absolute output directory outside checkout required')
    if out.exists():
        raise ValueError('output path already exists; no overwrite')
    return out


def postgres_readiness_command(container):
    # The image entrypoint temporarily starts a Unix-socket-only init server.
    # Authenticate over TCP to the requested database before creating any marker.
    return ['docker', 'exec', '-e', 'PGPASSWORD=' + DB_PASSWORD,
            '-e', 'PGCONNECT_TIMEOUT=2', '-e', 'PGOPTIONS=-c statement_timeout=1000',
            container, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', DB_NAME,
            '-c', 'SELECT 1']


def resource_owned(details, owner, sha, kind):
    labels = details.get('Config', {}).get('Labels', {}) if kind == 'container' else details.get('Labels', {})
    return isinstance(labels, dict) and labels.get(OWNER_LABEL) == owner and labels.get(SHA_LABEL) == sha


def plan(sha, owner):
    prefix = 'ghfind-http-' + owner[:8]
    return {'sourceSha': sha, 'fixtureOwner': owner, 'scope': SCOPE, 'resources': {
        'postgres': prefix + '-pg', 'api': prefix + '-api', 'network': prefix, 'volume': prefix + '-pgdata'},
        'ports': {'postgresLoopback': PG_PORT, 'apiLoopback': API_PORT},
        'postgresImage': PG_IMAGE, 'apiImage': 'Dockerfile.feed --target api; immutable build image ID; default feed-api entrypoint',
        'limits': {'projects': 50, 'httpRequests': 100, 'contractSeconds': 120,
                   'postgresCPUs': 1, 'postgresMemoryBytes': 1073741824, 'apiCPUs': 0.5, 'apiMemoryBytes': 268435456},
        'defaultAction': 'dry-run; requires --execute to build images or create resources'}


class Harness:
    def __init__(self, root, out, sha, owner):
        self.root, self.out, self.sha, self.owner = root, out, sha, owner
        self.plan = plan(sha, owner)
        self.names = self.plan['resources']
        self.attempted = []
        self.image_id = None
        self.image_build_attempted = False
        self.report = {**self.plan, 'format': 'ghfind-docker-http-run-v1', 'startedAt': utc(),
                       'status': 'incomplete', 'commands': [], 'created': [], 'cleanup': []}

    def save(self):
        temp = self.out / 'run.json.tmp'
        temp.write_text(json.dumps(self.report, indent=2) + '\n')
        temp.chmod(0o600)
        temp.replace(self.out / 'run.json')

    def run(self, args, *, timeout=30, check=True, env=None, input=None, log=None):
        at = time.monotonic()
        record = {'at': utc(), 'argv': args, 'timeoutSeconds': timeout}
        try:
            p = subprocess.run(args, cwd=self.root, env=env, input=input, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
            record.update(exitCode=p.returncode, durationSeconds=time.monotonic() - at)
            if log:
                (self.out / log).write_text(p.stdout + p.stderr)
                record['log'] = log
            if check and p.returncode:
                raise RuntimeError('command_failed')
            return p
        except subprocess.TimeoutExpired:
            record.update(outcome='timeout', durationSeconds=time.monotonic() - at)
            raise RuntimeError('command_timeout') from None
        finally:
            self.report['commands'].append(record)
            self.save()

    def inspect(self, kind, name):
        # Only the exact current-run names/IDs are inspected; do not enumerate
        # application environment variables or unrelated service configuration.
        p = self.run(['docker', kind, 'inspect', name], check=False, timeout=10)
        if p.returncode:
            if re.search(r'(?i)(no such (?:object|container|network|volume|image)|not found)', p.stderr) and not re.search(r'(?i)(cannot connect|connection|permission|denied|dial |TLS|context)', p.stderr):
                return None
            raise RuntimeError('resource_inspection_failed')
        values = json.loads(p.stdout)
        if len(values) != 1:
            raise RuntimeError('ambiguous_resource_identity')
        return values[0]

    def create(self, kind, name, args):
        # A timeout after daemon-side creation is uncertain. Cleanup subsequently
        # requires both this attempted name and our cryptographic owner label.
        self.attempted.append((kind, name))
        p = self.run(args, timeout=90)
        identity = p.stdout.strip()
        details = self.inspect(kind, name)
        if details is None or not resource_owned(details, self.owner, self.sha, kind):
            raise RuntimeError('created_resource_identity_mismatch')
        self.report['created'].append({'kind': kind, 'name': name, 'id': details.get('Id', name)})
        self.save()
        return identity

    def cleanup(self):
        failed = False
        for kind, name in reversed(self.attempted):
            try:
                details = self.inspect(kind, name)
                if details is None:
                    self.report['cleanup'].append({'kind': kind, 'name': name, 'status': 'absent'})
                    continue
                if not resource_owned(details, self.owner, self.sha, kind):
                    self.report['cleanup'].append({'kind': kind, 'name': name, 'status': 'ownership_mismatch_not_removed'})
                    failed = True
                    continue
                identity = details.get('Id', name)
                args = ['docker', kind, 'rm'] + (['-f', '-v'] if kind == 'container' else []) + [identity]
                self.run(args, timeout=20)
                if self.inspect(kind, name) is not None:
                    raise RuntimeError('cleanup_still_present')
                self.report['cleanup'].append({'kind': kind, 'name': name, 'id': identity, 'status': 'removed'})
            except Exception:
                failed = True
                self.report['cleanup'].append({'kind': kind, 'name': name, 'status': 'cleanup_failed'})
        iid_file = self.out / 'api-image-id.txt'
        if not self.image_id and iid_file.exists():
            candidate = iid_file.read_text().strip()
            if re.fullmatch(r'sha256:[a-f0-9]{64}', candidate):
                self.image_id = candidate
        if self.image_id:
            try:
                details = self.inspect('image', self.image_id)
                if details is not None:
                    if not resource_owned(details, self.owner, self.sha, 'container'):
                        raise RuntimeError('image_ownership_mismatch')
                    self.run(['docker', 'image', 'rm', '--no-prune', self.image_id], timeout=20)
                self.report['cleanup'].append({'kind': 'image', 'id': self.image_id, 'status': 'removed_or_absent'})
            except Exception:
                failed = True
                self.report['cleanup'].append({'kind': 'image', 'status': 'cleanup_failed'})
        elif self.image_build_attempted:
            failed = True
            self.report['cleanup'].append({'kind': 'image', 'status': 'build_identity_uncertain_not_claimed_absent'})
        self.report['cleanupSuccessful'] = not failed
        self.save()
        return not failed

    def execute(self):
        result = 1
        self.out.mkdir(mode=0o700)
        self.save()
        try:
            if self.run(['git', 'rev-parse', 'HEAD']).stdout.strip() != self.sha:
                raise RuntimeError('checkout_sha_mismatch')
            if self.run(['git', 'status', '--porcelain']).stdout.strip():
                raise RuntimeError('clean_checkout_required')
            if os.environ.get('DOCKER_HOST') and not os.environ['DOCKER_HOST'].startswith('unix://'):
                raise RuntimeError('only_local_unix_docker_allowed')
            context = self.run(['docker', 'context', 'show']).stdout.strip()
            endpoint = json.loads(self.run(['docker', 'context', 'inspect', context]).stdout)[0]['Endpoints']['docker']['Host']
            if not endpoint.startswith('unix://') or (os.environ.get('DOCKER_HOST') and not os.environ['DOCKER_HOST'].startswith('unix://')):
                raise RuntimeError('only_local_unix_docker_allowed')
            self.run(['docker', 'info', '--format', '{{.ServerVersion}}'])
            # Any pre-existing name or occupied host port aborts before creation.
            for kind, name in [('container', self.names['postgres']), ('container', self.names['api']), ('network', self.names['network']), ('volume', self.names['volume'])]:
                if self.inspect(kind, name) is not None:
                    raise RuntimeError('resource_collision')
            for port in (PG_PORT, API_PORT):
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', port))
            labels = ['--label', OWNER_LABEL + '=' + self.owner, '--label', SHA_LABEL + '=' + self.sha]
            iid = self.out / 'api-image-id.txt'
            self.image_build_attempted = True
            self.report['apiImageBuildAttempted'] = True
            self.save()
            self.run(['docker', 'build', '--platform', 'linux/amd64', '--target', 'api', '-f', 'Dockerfile.feed', '--build-arg', 'VERSION=' + self.sha, '--iidfile', str(iid), *labels, '.'], timeout=300, log='build.log')
            self.image_id = iid.read_text().strip()
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', self.image_id):
                raise RuntimeError('immutable_image_id_required')
            self.report['imageId'] = self.image_id
            harness = self.out / 'contract.test'
            migration = self.out / 'feed-migrate'
            self.run(['go', 'test', '-c', '-tags', 'feedportability', '-ldflags', '-X github.com/hikariming/ghfind/internal/backend.portabilityBuildSHA=' + self.sha, '-o', str(harness), './internal/backend'], timeout=120, log='harness-build.log')
            self.run(['go', 'build', '-trimpath', '-o', str(migration), './cmd/ghfind-feed-migrate'], timeout=120, log='migration-build.log')
            self.report['binaries'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [harness, migration]}
            self.create('network', self.names['network'], ['docker', 'network', 'create', *labels, self.names['network']])
            self.create('volume', self.names['volume'], ['docker', 'volume', 'create', *labels, self.names['volume']])
            pg = self.names['postgres']
            self.create('container', pg, ['docker', 'create', '--name', pg, '--platform', 'linux/amd64', *labels, '--network', self.names['network'], '--cpus', '1', '--memory', '1g', '--memory-swap', '1g', '--shm-size', '128m', '--pids-limit', '128', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=' + DB_PASSWORD, '-e', 'POSTGRES_DB=' + DB_NAME, '-p', f'127.0.0.1:{PG_PORT}:5432', '-p', f'127.0.0.1:{API_PORT}:8080', '--mount', 'type=volume,source=' + self.names['volume'] + ',target=/var/lib/postgresql/data', PG_IMAGE, 'postgres', '-c', 'shared_buffers=128MB', '-c', 'max_connections=40'])
            self.run(['docker', 'start', pg])
            for _ in range(40):
                ready = self.run(postgres_readiness_command(pg), timeout=3, check=False)
                if ready.returncode == 0 and ready.stdout.strip() == '1':
                    break
                time.sleep(.25)
            else:
                raise RuntimeError('postgres_startup_failed')
            # Fixed SQL only, UUID/SHA originate locally and match strict formats.
            marker = f"""CREATE EXTENSION vector;
CREATE TABLE public.feed_portability_fixture(singleton boolean PRIMARY KEY CHECK(singleton),owner_id uuid NOT NULL,source_sha text NOT NULL,fixture_version text NOT NULL,api_port integer NOT NULL,claimed boolean NOT NULL DEFAULT false);
INSERT INTO public.feed_portability_fixture VALUES(true,'{self.owner}','{self.sha}','ghfind-docker-http-v1',{API_PORT},false);
"""
            self.run(['docker', 'exec', '-i', pg, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', DB_NAME], input=marker, log='fixture-marker.log')
            dsn = f'postgres://postgres:{DB_PASSWORD}@127.0.0.1:{PG_PORT}/{DB_NAME}?sslmode=disable&connect_timeout=3'
            env = {**os.environ, 'FEED_DATABASE_URL': dsn}
            self.run([str(migration)], env=env, timeout=60, log='migration.log')
            api = self.names['api']
            api_dsn = f'postgres://postgres:{DB_PASSWORD}@127.0.0.1:5432/{DB_NAME}?sslmode=disable&connect_timeout=3'
            envs = {'PORT': '8080', 'FEED_MODE': 'baseline', 'FEED_STORE_PROFILE': 'postgres', 'FEED_WRITER_EPOCH': '1', 'FEED_DATABASE_URL': api_dsn, 'FEED_GATEWAY_SECRET': GATEWAY, 'FEED_SIGNING_SECRET': SIGNING}
            args = ['docker', 'create', '--name', api, '--platform', 'linux/amd64', *labels, '--network', 'container:' + pg, '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '0.5', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64', '--ulimit', 'nofile=4096:4096', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777']
            for k, v in envs.items():
                args += ['-e', k + '=' + v]
            args += [self.image_id]  # The standard image's default API entrypoint.
            self.create('container', api, args)
            details = self.inspect('container', api)
            if details['Image'] != self.image_id or details['Path'] != '/usr/local/bin/feed-api':
                raise RuntimeError('api_image_entrypoint_mismatch')
            self.report['apiRuntime'] = {'id': details['Id'], 'imageId': details['Image'], 'entrypoint': details['Path'], 'user': details['Config']['User'], 'readonlyRoot': details['HostConfig']['ReadonlyRootfs'], 'cpuNano': details['HostConfig']['NanoCpus'], 'memoryBytes': details['HostConfig']['Memory']}
            self.run(['docker', 'start', api])
            # Wait for the listener without spending extra unrecorded HTTP calls.
            for _ in range(40):
                try:
                    with socket.create_connection(('127.0.0.1', API_PORT), timeout=.25):
                        break
                except OSError:
                    time.sleep(.25)
            else:
                raise RuntimeError('api_listener_unavailable')
            env = {**os.environ, 'FEED_PORTABILITY_DATABASE_URL': dsn, 'FEED_PORTABILITY_API_ENDPOINT': f'http://127.0.0.1:{API_PORT}', 'FEED_PORTABILITY_SOURCE_SHA': self.sha, 'FEED_PORTABILITY_OWNER': self.owner, 'FEED_PORTABILITY_API_CONTAINER': details['Id'], 'FEED_PORTABILITY_PG_CONTAINER': self.inspect('container', pg)['Id'], 'FEED_PORTABILITY_IMAGE_ID': self.image_id, 'FEED_PORTABILITY_REPORT': str(self.out / 'contract.json')}
            self.run([str(harness), '-test.run', '^TestFeedDockerHTTPPortability$', '-test.v', '-test.timeout', '125s'], env=env, timeout=130, log='contract.log')
            contract = json.loads((self.out / 'contract.json').read_text())
            if contract['status'] != 'passed' or contract['sourceSha'] != self.sha or contract['httpCalls'] > 100 or contract['durationSeconds'] > 120:
                raise RuntimeError('contract_incomplete')
            self.report['contractStatus'] = 'passed'
            result = 0
        except (Exception, KeyboardInterrupt) as error:
            self.report['errorCode'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        finally:
            # Read logs only for positively matched resources from this attempt.
            for kind, name in self.attempted:
                if kind != 'container':
                    continue
                try:
                    details = self.inspect(kind, name)
                    if details and resource_owned(details, self.owner, self.sha, kind):
                        self.run(['docker', 'logs', '--timestamps', details['Id']], check=False, log=name + '.log', timeout=10)
                except Exception:
                    pass
            if not self.cleanup():
                result = 1
            self.report['status'] = 'passed' if result == 0 else 'failed'
            self.report['finishedAt'] = utc()
            self.save()
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-sha', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--execute', action='store_true', help='explicitly build and create local synthetic resources')
    args = parser.parse_args(argv)
    root = pathlib.Path(__file__).resolve().parents[1]
    try:
        out = validate_options(args.release_sha, args.directory, root)
    except ValueError as e:
        parser.error(str(e))
    owner = str(uuid.uuid4())
    if not args.execute:
        print(json.dumps(plan(args.release_sha, owner), indent=2))
        return 0
    # SIGTERM joins the same finally cleanup path; no global destructive cleanup.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    return Harness(root, out, args.release_sha, owner).execute()


if __name__ == '__main__':
    sys.exit(main())
