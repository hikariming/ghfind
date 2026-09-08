#!/usr/bin/env python3
"""No Docker/DB/network calls: validate orchestration identity and failure cleanup."""
import importlib.util
import io
import subprocess
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docker_http', pathlib.Path(__file__).with_name('run-feed-docker-http.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = 'a' * 40
OWNER = '11111111-1111-4111-8111-111111111111'


class SafetyTests(unittest.TestCase):
    def test_requires_exact_sha_and_fresh_external_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / 'repo'; root.mkdir()
            out = pathlib.Path(temp) / 'new'
            self.assertEqual(m.validate_options(SHA, str(out), root), out)
            for sha, target in [('main', out), (SHA, root / 'inside'), (SHA, root), (SHA, pathlib.Path('relative'))]:
                with self.assertRaises(ValueError):
                    m.validate_options(sha, str(target), root)

    def test_resource_cleanup_requires_both_labels(self):
        for kind in ['container', 'network', 'volume']:
            labels = {m.OWNER_LABEL: OWNER, m.SHA_LABEL: SHA}
            details = {'Config': {'Labels': labels}} if kind == 'container' else {'Labels': labels}
            self.assertTrue(m.resource_owned(details, OWNER, SHA, kind))
            self.assertFalse(m.resource_owned(details, 'another-owner', SHA, kind))
            self.assertFalse(m.resource_owned(details, OWNER, 'b' * 40, kind))

    def test_cleanup_never_removes_collision(self):
        with tempfile.TemporaryDirectory() as temp:
            h = m.Harness(pathlib.Path(temp), pathlib.Path(temp), SHA, OWNER)
            h.attempted = [('container', 'collision')]
            h.inspect = lambda *_: {'Id': 'foreign-id', 'Config': {'Labels': {m.OWNER_LABEL: 'foreign'}}}
            calls = []
            h.run = lambda args, **kw: calls.append(args)
            self.assertFalse(h.cleanup())
            self.assertEqual(calls, [])
            self.assertEqual(h.report['cleanup'][0]['status'], 'ownership_mismatch_not_removed')

    def test_uncertain_creation_is_removed_only_after_ownership_readback(self):
        with tempfile.TemporaryDirectory() as temp:
            h = m.Harness(pathlib.Path(temp), pathlib.Path(temp), SHA, OWNER)
            h.attempted = [('container', 'owned')]
            details = {'Id': 'owned-id', 'Config': {'Labels': {m.OWNER_LABEL: OWNER, m.SHA_LABEL: SHA}}}
            reads = iter([details, None]); h.inspect = lambda *_: next(reads)
            calls = []; h.run = lambda args, **kw: calls.append(args)
            self.assertTrue(h.cleanup())
            self.assertEqual(calls, [['docker', 'container', 'rm', '-f', '-v', 'owned-id']])

    def test_partial_creation_and_empty_attempt_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            h = m.Harness(pathlib.Path(temp), pathlib.Path(temp), SHA, OWNER)
            h.run = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError('command_timeout'))
            with self.assertRaises(RuntimeError):
                h.create('network', 'owned-network', ['docker', 'network', 'create', 'owned-network'])
            self.assertEqual(h.attempted, [('network', 'owned-network')])
            h.inspect = lambda *_: None
            self.assertTrue(h.cleanup())
            h.attempted = []; self.assertTrue(h.cleanup())

    def test_inspect_does_not_confuse_daemon_failure_with_absence(self):
        with tempfile.TemporaryDirectory() as temp:
            h=m.Harness(pathlib.Path(temp),pathlib.Path(temp),SHA,OWNER)
            h.run=lambda *a,**kw: subprocess.CompletedProcess([],1,'','Error response from daemon: get owned: no such volume')
            self.assertIsNone(h.inspect('volume','owned'))
            h.run=lambda *a,**kw: subprocess.CompletedProcess([],1,'','Cannot connect to the Docker daemon')
            with self.assertRaises(RuntimeError): h.inspect('volume','owned')

    def test_dry_run_never_calls_subprocess_or_creates_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            out = pathlib.Path(temp) / 'fresh'
            with patch.object(m.subprocess, 'run', side_effect=AssertionError('must not call Docker/git')), patch('sys.stdout',new_callable=io.StringIO):
                self.assertEqual(m.main(['--release-sha', SHA, '--directory', str(out)]), 0)
            self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
