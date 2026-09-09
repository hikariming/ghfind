import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'run-feed-e2e.py'
spec = importlib.util.spec_from_file_location('feed_e2e', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SafetyGates(unittest.TestCase):
    def harness(self, directory):
        base = pathlib.Path(directory)
        output = base / 'output'
        output.mkdir()
        return module.Harness(base, output, 'a' * 40)

    def wait_file(self, path):
        deadline = time.monotonic() + 5
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(path.exists(), 'fixture child failed to start')

    def test_parent_exit_does_not_hide_live_group_or_kill_unowned_group(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = self.harness(directory)
            child_file = pathlib.Path(directory) / 'child'
            # The child ignores TERM to force group-based escalation after the
            # direct parent has already exited and been reaped.
            child = "import os,pathlib,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path(" + repr(str(child_file)) + ").write_text(str(os.getpid())); time.sleep(60)"
            parent = 'import subprocess,sys; subprocess.Popen([sys.executable,"-c",' + repr(child) + '])'
            sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
            process = harness.start([sys.executable, '-c', parent], harness.env, harness.out / 'parent.log')
            try:
                self.wait_file(child_file)
                self.assertEqual(process.wait(timeout=5), 0)
                self.assertTrue(harness.group_exists(process))
                with self.assertRaisesRegex(RuntimeError, 'unowned_process_group'):
                    harness.group_exists(sentinel)
                self.assertTrue(harness.stop_process(process, term_seconds=.1, kill_seconds=5))
                self.assertEqual(harness.processes, [])
                with self.assertRaises(ProcessLookupError):
                    os.killpg(process.pid, 0)
                self.assertIsNone(sentinel.poll(), 'cleanup killed an unowned session')
            finally:
                harness.stop_processes()
                sentinel.terminate()
                sentinel.wait(timeout=5)

    def test_command_timeout_cleans_browser_like_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = self.harness(directory)
            child_file = pathlib.Path(directory) / 'child'
            child = 'import time; time.sleep(60)'
            parent = ('import os,pathlib,subprocess,sys,time; '
                      'child=subprocess.Popen([sys.executable,"-c",' + repr(child) + ']); '
                      'pathlib.Path(' + repr(str(child_file)) + ').write_text(str(os.getpgrp())); time.sleep(60)')
            try:
                with self.assertRaisesRegex(RuntimeError, 'timeout-fixture_timeout'):
                    harness.command([sys.executable, '-c', parent], 'timeout-fixture', timeout=.5)
                self.wait_file(child_file)
                self.assertEqual(harness.processes, [])
                with self.assertRaises(ProcessLookupError):
                    os.killpg(int(child_file.read_text()), 0)
                self.assertTrue(harness.report['commands'][-1]['timedOut'])
            finally:
                harness.stop_processes()

    def test_actual_playwright_timeout_leaves_no_chromium_group(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = self.harness(directory)
            browser_file = pathlib.Path(directory) / 'browser-pid'
            playwright = (source.parents[1] / 'node_modules/playwright/index.mjs').as_uri()
            script = ('import {chromium} from ' + json.dumps(playwright) + '; '
                      'import {writeFileSync} from "node:fs"; '
                      'const server=await chromium.launchServer({headless:true}); '
                      'writeFileSync(' + json.dumps(str(browser_file)) + ',String(server.process().pid)); '
                      'await new Promise(()=>{});')
            try:
                with self.assertRaisesRegex(RuntimeError, 'playwright-timeout_timeout'):
                    harness.command(['node', '--input-type=module', '-e', script], 'playwright-timeout', timeout=5)
                self.wait_file(browser_file)
                self.assertEqual(harness.processes, [])
                # Chromium uses a distinct session. Playwright's TERM hook must
                # actually close it before our Node process group disappears.
                browser_group = int(browser_file.read_text())
                with self.assertRaises(ProcessLookupError):
                    os.killpg(browser_group, 0)
            finally:
                harness.stop_processes()

    def test_output_and_source_are_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            root = base / 'repo'
            root.mkdir()
            self.assertEqual(module.options_valid('a' * 40, str(base / 'new'), root), base / 'new')
            for target in [root, root / 'inside', base]:
                with self.assertRaises(ValueError):
                    module.options_valid('a' * 40, str(target), root)
            with self.assertRaises(ValueError):
                module.options_valid('main', str(base / 'new'), root)

    def test_cleanup_requires_both_owner_and_source(self):
        config = {'Config': {'Labels': {module.OWNER_LABEL: 'owner', module.SHA_LABEL: 'a' * 40}}}
        self.assertTrue(module.owned(config, 'owner', 'a' * 40))
        self.assertFalse(module.owned(config, 'other', 'a' * 40))
        self.assertFalse(module.owned(config, 'owner', 'b' * 40))

    def test_no_skip_or_partial_pass_can_be_receipt(self):
        report = {'format': module.FORMAT, 'status': 'passed', 'sourceSha': 'a' * 40, 'sourceTree': 'b' * 40, 'cleanupSuccessful': True,
                  'profiles': {key: {'status': 'passed', 'milestones': dict.fromkeys(module.MILESTONES, True)} for key in ['cf_d1_r2', 'postgres']}}
        module.validate_receipt(report, 'a' * 40, 'b' * 40)
        report['profiles']['postgres']['milestones']['deletionCompleted'] = False
        with self.assertRaises(ValueError):
            module.validate_receipt(report, 'a' * 40, 'b' * 40)
        report['profiles'].pop('postgres')
        with self.assertRaises(ValueError):
            module.validate_receipt(report, 'a' * 40, 'b' * 40)


if __name__ == '__main__':
    unittest.main()
