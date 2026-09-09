#!/usr/bin/env python3
"""Complete local Feed browser journeys on BOTH real storage profiles; no skip path."""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

PG_IMAGE = 'pgvector/pgvector@sha256:137f044b0efe3d57f39b972b9b53641b1f2045b99d879e298bbf514a25787dcf'
MINIO_IMAGE = 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'
FORMAT = 'ghfind-complete-local-e2e-v1'
MILESTONES = ['oauthCallback', 'assessmentFinalization', 'sourceOutbox', 'executorProjection', 'governance', 'preferences', 'events', 'deletionCompleted']
OWNER_LABEL = 'io.ghfind.fixture.owner'
SHA_LABEL = 'io.ghfind.fixture.source'
DB_NAME = 'feed_complete_e2e_test'


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def options_valid(sha, directory, root):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('exact lowercase 40-hex SHA required')
    output = pathlib.Path(directory)
    if not output.is_absolute() or root.resolve() == output.resolve() or root.resolve() in output.resolve().parents or output.exists():
        raise ValueError('fresh absolute output directory outside checkout required')
    return output


def owned(details, owner, sha):
    labels = details.get('Config', {}).get('Labels', {})
    return labels.get(OWNER_LABEL) == owner and labels.get(SHA_LABEL) == sha


def validate_receipt(receipt, sha, tree):
    if receipt.get('format') != FORMAT or receipt.get('status') != 'passed' or receipt.get('sourceSha') != sha or receipt.get('sourceTree') != tree or receipt.get('cleanupSuccessful') is not True:
        raise ValueError('incomplete local e2e receipt')
    if set(receipt.get('profiles', {})) != {'cf_d1_r2', 'postgres'}:
        raise ValueError('both profiles required')
    for profile in receipt['profiles'].values():
        if profile.get('status') != 'passed' or any(profile.get('milestones', {}).get(key) is not True for key in MILESTONES):
            raise ValueError('required journey milestone absent')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def isolated_environment():
    # Do not inherit developer/CI production credentials or application overrides.
    names = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'GOCACHE', 'GOMODCACHE', 'GOPATH', 'PLAYWRIGHT_BROWSERS_PATH']
    env = {key: os.environ[key] for key in names if key in os.environ}
    env.update(CI='true', NEXT_TELEMETRY_DISABLED='1', WRANGLER_SEND_METRICS='false', NO_COLOR='1', NODE_ENV='development', TURSO_DATABASE_URL='', TURSO_AUTH_TOKEN='', UPSTASH_REDIS_REST_URL='', UPSTASH_REDIS_REST_TOKEN='', GITHUB_TOKEN='', GH_TOKEN='')
    return env


class Harness:
    def __init__(self, root, out, sha):
        self.root, self.out, self.sha = root, out, sha
        self.owner = str(uuid.uuid4())
        self.env = isolated_environment()
        self.containers, self.processes = [], []
        self.report = {'format': FORMAT, 'sourceSha': sha, 'sourceTree': '', 'status': 'failed', 'startedAt': utc(), 'realOAuth': False, 'externalProviders': 'local-fixture-transports', 'profiles': {}, 'cleanupSuccessful': False, 'commands': [], 'cleanup': []}
        self.keys = {key: uuid.uuid4().hex + uuid.uuid4().hex for key in ['FEED_GATEWAY_SECRET', 'FEED_SIGNING_SECRET', 'FEED_BRIDGE_SECRET', 'FEED_RUNTIME_ADMIN_SECRET', 'FEED_EXECUTOR_SECRET', 'FEED_SOURCE_SECRET', 'FEED_DELIVERY_SECRET', 'FEED_OPERATOR_SECRET', 'AUTH_SECRET', 'AUTH_GITHUB_SECRET']}
        self.pg_password = uuid.uuid4().hex
        self.s3_password = uuid.uuid4().hex

    def save(self):
        (self.out / 'run.json').write_text(json.dumps(self.report, indent=2) + '\n')
        (self.out / 'run.json').chmod(0o600)

    def command(self, args, label, *, timeout=60, env=None, input=None, check=True):
        start = time.monotonic()
        process = subprocess.Popen(args, cwd=self.root, env=env or self.env, text=True,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
        self.processes.append((process, None))
        timed_out = False
        try:
            stdout, stderr = process.communicate(input=input, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            if not self.stop_process(process):
                raise RuntimeError('local_process_cleanup_failed')
            stdout, stderr = process.communicate(timeout=5)
        finally:
            # A successful/failed parent may leave children behind, too. These
            # commands have their own group just like the long-running servers.
            if not self.stop_process(process):
                raise RuntimeError('local_process_cleanup_failed')
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        # Logs are private fixture-only files; command environment/credentials are
        # never serialized in the evidence receipt.
        log_text = result.stdout + result.stderr
        for value in [*self.keys.values(), self.pg_password, self.s3_password]:
            log_text = log_text.replace(value, '[redacted-local-fixture-credential]')
        (self.out / (label + '.log')).write_text(log_text)
        (self.out / (label + '.log')).chmod(0o600)
        self.report['commands'].append({'name': label, 'exitCode': result.returncode, 'durationSeconds': time.monotonic() - start, **({'timedOut': True} if timed_out else {})})
        self.save()
        if timed_out:
            raise RuntimeError(label + '_timeout')
        if check and result.returncode:
            raise RuntimeError(label + '_failed')
        return result

    def start(self, args, env, log):
        stream = open(log, 'w')
        os.chmod(log, 0o600)
        process = subprocess.Popen(args, cwd=self.root, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append((process, stream))
        return process

    def group_exists(self, process):
        # Only Popen handles registered immediately after start_new_session=True
        # are eligible. Never accept an arbitrary PID or our own process group.
        if not any(entry[0] is process for entry in self.processes) or process.pid <= 1 or process.pid == os.getpgrp():
            raise RuntimeError('unowned_process_group')
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # macOS briefly returns EPERM for a group whose leader is a zombie.
            # Treat it as present until reaping proves the whole group absent.
            return True

    def stop_process(self, process, term_seconds=12, kill_seconds=5):
        entry = next((entry for entry in self.processes if entry[0] is process), None)
        if entry is None:
            return True  # Already confirmed absent and removed from tracking.
        try:
            for sig, seconds in [(signal.SIGTERM, term_seconds), (signal.SIGKILL, kill_seconds)]:
                process.poll()
                if not self.group_exists(process):
                    break
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    break
                except PermissionError:
                    pass  # Still require subsequent absence; never claim clean.
                deadline = time.monotonic() + seconds
                while self.group_exists(process) and time.monotonic() < deadline:
                    process.poll()  # Reap our child; descendants can outlive it.
                    time.sleep(.05)
            process.poll()
            if self.group_exists(process) or process.poll() is None:
                return False
        except OSError:
            return False
        if entry[1] is not None:
            entry[1].close()
        self.processes.remove(entry)
        return True

    def stop_processes(self):
        successful = True
        for process, _ in reversed(self.processes.copy()):
            successful = self.stop_process(process) and successful
        return successful

    def inspect(self, name):
        result = self.command(['docker', 'container', 'inspect', name], 'inspect-' + name, timeout=10, check=False)
        if result.returncode:
            if re.search(r'(?i)no such (?:object|container)', result.stderr):
                return None
            raise RuntimeError('docker_inspection_failed')
        rows = json.loads(result.stdout)
        if len(rows) != 1:
            raise RuntimeError('ambiguous_docker_identity')
        return rows[0]

    def create_container(self, name, args):
        if self.inspect(name) is not None:
            raise RuntimeError('resource_collision')
        self.containers.append(name)  # Track even uncertain daemon-side creations.
        self.command(['docker', 'run', '-d', '--name', name, '--label', OWNER_LABEL + '=' + self.owner, '--label', SHA_LABEL + '=' + self.sha, *args], 'create-' + name, timeout=180)
        details = self.inspect(name)
        if not details or not owned(details, self.owner, self.sha):
            raise RuntimeError('created_resource_identity_mismatch')

    def wait_http(self, url, process=None, seconds=60):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if process and process.poll() is not None:
                raise RuntimeError('service_exited_before_readiness')
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200:
                        return json.load(response) if response.headers.get_content_type() == 'application/json' else {}
            except (OSError, ValueError):
                pass
            time.sleep(.25)
        raise RuntimeError('service_readiness_deadline')

    def create_bucket(self, port):
        # AWS SigV4 against the owned loopback MinIO instance; no SDK-specific
        # test database or fake S3 service is substituted.
        host, bucket = f'127.0.0.1:{port}', 'feed-complete-e2e'
        now = datetime.datetime.now(datetime.timezone.utc)
        amzdate, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
        digest = hashlib.sha256(b'').hexdigest()
        canonical_headers = f'host:{host}\nx-amz-content-sha256:{digest}\nx-amz-date:{amzdate}\n'
        signed = 'host;x-amz-content-sha256;x-amz-date'
        canonical = f'PUT\n/{bucket}\n\n{canonical_headers}\n{signed}\n{digest}'
        scope = f'{day}/us-east-1/s3/aws4_request'
        sign = f'AWS4-HMAC-SHA256\n{amzdate}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
        key = ('AWS4' + self.s3_password).encode()
        for part in [day, 'us-east-1', 's3', 'aws4_request']:
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key, sign.encode(), hashlib.sha256).hexdigest()
        headers = {'x-amz-content-sha256': digest, 'x-amz-date': amzdate, 'Authorization': f'AWS4-HMAC-SHA256 Credential=feed-local/{scope}, SignedHeaders={signed}, Signature={signature}'}
        request = urllib.request.Request(f'http://{host}/{bucket}', data=b'', headers=headers, method='PUT')
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 200:
                raise RuntimeError('s3_bucket_create_failed')

    def profile(self, profile, pg_port, s3_port, pg_container):
        directory = self.out / profile
        directory.mkdir(mode=0o700)
        ports = {key: free_port() for key in ['webPort', 'apiPort', 'executorPort', 'adapterPort', 'controlPort']}
        config = {'format': 'ghfind-local-e2e-config-v1', 'sourceSha': self.sha, 'sourceTree': self.report['sourceTree'], 'owner': self.owner, 'profile': profile, 'postgresContainer': pg_container, 'directory': str(directory), **ports}
        config_path = directory / 'config.json'
        config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
        origin = f'http://127.0.0.1:{ports["webPort"]}'
        adapter = f'http://127.0.0.1:{ports["adapterPort"]}'
        env = {**self.env, **self.keys, 'AUTH_GITHUB_ID': 'local-e2e-oauth', 'GHFIND_OAUTH_ENABLED': '1', 'PUBLIC_SITE_URL': origin, 'NEXT_PUBLIC_SITE_URL': origin, 'GHFIND_DEPLOY_ENV': 'development', 'FEED_BACKEND': 'go', 'FEED_API_ORIGIN': f'http://127.0.0.1:{ports["apiPort"]}', 'FEED_SOURCE_OUTBOX_ENABLED': 'true', 'MOSOO_API_BASE': 'https://feed-e2e-provider.invalid/api/v1', 'MOSOO_API_TOKEN': 'local-fixture-provider', 'MOSOO_PROJECT_AGENT_ID': 'local-e2e-agent', 'FEED_MODE': 'baseline', 'FEED_STORE_PROFILE': profile, 'FEED_WRITER_EPOCH': '1', 'FEED_BRIDGE_ENDPOINT': adapter, 'FEED_SOURCE_ENDPOINT': adapter, 'FEED_CLEANUP_ENDPOINT': adapter, 'FEED_ARCHIVE_ENDPOINT': adapter, 'FEED_EXECUTOR_ENABLED': 'true', 'FEED_DATABASE_URL': f'postgres://postgres:{self.pg_password}@127.0.0.1:{pg_port}/{DB_NAME}?sslmode=disable&connect_timeout=3', 'FEED_ARCHIVE_S3_ENDPOINT': f'http://127.0.0.1:{s3_port}', 'FEED_ARCHIVE_S3_REGION': 'us-east-1', 'FEED_ARCHIVE_S3_BUCKET': 'feed-complete-e2e', 'FEED_ARCHIVE_S3_ACCESS_KEY_ID': 'feed-local', 'FEED_ARCHIVE_S3_SECRET_ACCESS_KEY': self.s3_password, 'FEED_ARCHIVE_S3_PATH_STYLE': 'true'}
        server = self.start([str(self.root / 'node_modules/.bin/tsx'), str(self.root / 'scripts/feed-e2e/server.mts'), str(config_path)], env, directory / 'server.log')
        deadline = time.monotonic() + 120
        while not (directory / 'server-ready.json').exists():
            if server.poll() is not None:
                raise RuntimeError(profile + '_next_or_workerd_startup_failed')
            if time.monotonic() > deadline:
                raise RuntimeError(profile + '_next_or_workerd_startup_deadline')
            time.sleep(.25)
        if profile == 'postgres':
            self.command([str(self.out / 'feed-migrate')], profile + '-migrations', env=env)
        api = self.start([str(self.out / 'feed-api')], {**env, 'PORT': str(ports['apiPort'])}, directory / 'api.log')
        worker_env = {**env, 'PORT': str(ports['executorPort'])}
        if profile == 'cf_d1_r2':
            worker_env.pop('FEED_OPERATOR_SECRET')
        worker = self.start([str(self.out / 'feed-worker')], worker_env, directory / 'executor.log')
        for role, process, port in [('feed-api', api, ports['apiPort']), ('feed-worker', worker, ports['executorPort'])]:
            ready = self.wait_http(f'http://127.0.0.1:{port}/readyz', process)
            if ready.get('ready') is not True or ready.get('version') != self.sha or ready.get('service') != role or ready.get('storeProfile') != profile:
                raise RuntimeError('runtime_readiness_version_mismatch')
        result = self.command(['node', str(self.root / 'scripts/feed-e2e/journey.mjs'), str(config_path)], profile + '-browser', env=env, timeout=300, check=False)
        journey_path = directory / 'journey.json'
        journey = json.loads(journey_path.read_text()) if journey_path.exists() else {}
        self.report['profiles'][profile] = {'status': journey.get('status', 'failed'), 'milestones': journey.get('milestones', {}), 'report': profile + '/journey.json'}
        self.save()
        if result.returncode or journey.get('sourceSha') != self.sha or journey.get('sourceTree') != self.report['sourceTree'] or journey.get('status') != 'passed' or any(journey.get('milestones', {}).get(key) is not True for key in MILESTONES):
            raise RuntimeError(profile + '_complete_journey_failed')
        if not self.stop_processes():
            raise RuntimeError('local_process_cleanup_failed')

    def execute(self):
        self.out.mkdir(mode=0o700)
        self.save()
        success = False
        try:
            head = self.command(['git', 'rev-parse', 'HEAD'], 'checkout-sha').stdout.strip()
            if head != self.sha:
                raise RuntimeError('checkout_sha_mismatch')
            if self.command(['git', 'status', '--porcelain'], 'checkout-clean').stdout.strip():
                raise RuntimeError('clean_checkout_required')
            self.report['sourceTree'] = self.command(['git', 'rev-parse', 'HEAD^{tree}'], 'checkout-tree').stdout.strip()
            # Refuse ambient environment files: Next loads these implicitly.
            if any(self.root.glob('.env*')):
                existing = [p for p in self.root.glob('.env*') if p.name not in ['.env.example', '.env.local.example']]
                if existing:
                    raise RuntimeError('ambient_dotenv_forbidden_use_isolated_worktree')
            for executable in ['docker', 'go', 'node']:
                if not shutil.which(executable, path=self.env.get('PATH')):
                    raise RuntimeError('required_dependency_missing_' + executable)
            for dependency in ['node_modules/.bin/tsx', 'node_modules/playwright/package.json', 'platform/feed/node_modules/wrangler/package.json']:
                if not (self.root / dependency).exists():
                    raise RuntimeError('required_locked_node_dependency_missing')
            context = self.command(['docker', 'context', 'show'], 'docker-context').stdout.strip()
            endpoint = json.loads(self.command(['docker', 'context', 'inspect', context], 'docker-endpoint').stdout)[0]['Endpoints']['docker']['Host']
            if not endpoint.startswith('unix://') or (self.env.get('DOCKER_HOST') and not self.env['DOCKER_HOST'].startswith('unix://')):
                raise RuntimeError('local_unix_docker_required')
            self.command(['docker', 'info', '--format', '{{.ServerVersion}}'], 'docker-ready')
            for name, package in [('feed-api', './cmd/feed-api'), ('feed-worker', './cmd/feed-worker'), ('feed-migrate', './cmd/ghfind-feed-migrate')]:
                self.command(['go', 'build', '-trimpath', '-ldflags', '-X main.version=' + self.sha, '-o', str(self.out / name), package], 'build-' + name, timeout=180)
            self.report['binaries'] = {name: hashlib.sha256((self.out / name).read_bytes()).hexdigest() for name in ['feed-api', 'feed-worker', 'feed-migrate']}
            pg_port, s3_port = free_port(), free_port()
            prefix = 'ghfind-e2e-' + self.owner[:8]
            self.create_container(prefix + '-pg', ['--cpus', '1', '--memory', '1g', '--pids-limit', '128', '--shm-size', '128m', '-p', f'127.0.0.1:{pg_port}:5432', '-e', 'POSTGRES_PASSWORD=' + self.pg_password, '-e', 'POSTGRES_DB=' + DB_NAME, PG_IMAGE])
            for attempt in range(60):
                result = self.command(['docker', 'exec', '-e', 'PGPASSWORD=' + self.pg_password, prefix + '-pg', 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc', 'SELECT 1'], 'postgres-ready', timeout=3, check=False)
                if not result.returncode and result.stdout.strip() == '1':
                    break
                time.sleep(.25)
            else:
                raise RuntimeError('postgres_unavailable')
            self.command(['docker', 'exec', prefix + '-pg', 'psql', '-U', 'postgres', '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE EXTENSION vector'], 'enable-pgvector')
            self.create_container(prefix + '-s3', ['--cpus', '.5', '--memory', '512m', '--pids-limit', '128', '--tmpfs', '/data:rw,size=128m', '-p', f'127.0.0.1:{s3_port}:9000', '-e', 'MINIO_ROOT_USER=feed-local', '-e', 'MINIO_ROOT_PASSWORD=' + self.s3_password, MINIO_IMAGE, 'server', '/data'])
            self.wait_http(f'http://127.0.0.1:{s3_port}/minio/health/live')
            self.create_bucket(s3_port)
            for profile in ['cf_d1_r2', 'postgres']:
                self.profile(profile, pg_port, s3_port, prefix + '-pg')
            success = True
        except (Exception, KeyboardInterrupt) as error:
            self.report['errorCode'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        finally:
            cleaned = self.stop_processes()
            for name in reversed(self.containers):
                try:
                    details = self.inspect(name)
                    if details is None:
                        self.report['cleanup'].append({'name': name, 'status': 'absent'})
                        continue
                    if not owned(details, self.owner, self.sha):
                        raise RuntimeError('ownership_mismatch_not_removed')
                    self.command(['docker', 'container', 'rm', '-f', '-v', details['Id']], 'remove-' + name, timeout=20)
                    if self.inspect(name) is not None:
                        raise RuntimeError('container_still_present')
                    self.report['cleanup'].append({'name': name, 'status': 'removed'})
                except Exception:
                    cleaned = False
                    self.report['cleanup'].append({'name': name, 'status': 'cleanup_failed'})
            self.report['cleanupSuccessful'] = cleaned
            self.report['status'] = 'passed' if success and cleaned else 'failed'
            self.report['finishedAt'] = utc()
            self.save()
        if self.report['status'] == 'passed':
            validate_receipt(self.report, self.sha, self.report['sourceTree'])
            return 0
        print('Complete local E2E failed; inspect private evidence: ' + str(self.out / 'run.json'), file=sys.stderr)
        return 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-sha', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args(argv)
    root = pathlib.Path(__file__).resolve().parents[1]
    try:
        directory = options_valid(args.release_sha, args.directory, root)
    except ValueError as error:
        parser.error(str(error))
    if not args.execute:
        print(json.dumps({'format': FORMAT, 'sourceSha': args.release_sha, 'directory': str(directory), 'profiles': ['cf_d1_r2', 'postgres'], 'milestones': MILESTONES, 'externalProviders': 'local-fixture-transports', 'action': 'dry-run; --execute required'}, indent=2))
        return 0
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    return Harness(root, directory, args.release_sha).execute()


if __name__ == '__main__':
    sys.exit(main())
