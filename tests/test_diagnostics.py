import argparse
import contextlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tempfile
import threading
import unittest


spec = importlib.util.spec_from_file_location(
    'diagnose', Path(__file__).resolve().parents[1] / 'diagnostics' / 'diagnose.py')
diagnose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnose)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.bundle = root / 'Example.safariextension'
        self.page = self.bundle / 'background' / 'main.html'
        self.page.parent.mkdir(parents=True)
        self.original = b'<html>\r\n<head><title>Example</title></head>\r\n<body></body></html>'
        self.page.write_bytes(self.original)
        (self.bundle / 'Info.plist').write_bytes(plistlib.dumps(
            {'Chrome': {'Global Page': 'background/main.html'}}))
        self.session = root / 'session'
        self.session.mkdir()

    def install(self):
        diagnose.install(self.bundle, self.session, 'http://127.0.0.1:1234/example-token')

    def test_install_and_cleanup_restore_exact_original_bytes(self):
        self.install()
        self.assertIn(b'src="../wex/wex-local-diagnostics.js"', self.page.read_bytes())
        client = self.bundle / diagnose.CLIENT_PATH
        self.assertIn('http://127.0.0.1:1234/example-token', client.read_text())
        self.assertNotIn('__ENDPOINT__', client.read_text())
        diagnose.cleanup(self.session)
        self.assertEqual(self.page.read_bytes(), self.original)
        self.assertFalse(client.exists())
        diagnose.cleanup(self.session)  # Repeated cleanup is harmless.

    def test_page_without_head_or_body_tags_gets_the_tag_at_its_end(self):
        original = b'<!-- wex-bridge --><script src="a.js"></script><script src="b.js"></script>'
        self.page.write_bytes(original)
        self.install()
        installed = self.page.read_bytes()
        self.assertTrue(installed.startswith(original))
        self.assertIn(b'src="../wex/wex-local-diagnostics.js"', installed)
        diagnose.cleanup(self.session)
        self.assertEqual(self.page.read_bytes(), original)

    def test_cleanup_preserves_unrelated_edits(self):
        self.install()
        self.page.write_bytes(self.page.read_bytes().replace(b'Example', b'Edited'))
        diagnose.cleanup(self.session)
        self.assertEqual(self.page.read_bytes(), self.original.replace(b'Example', b'Edited'))

    def test_cleanup_does_not_restore_backup_over_reconversion(self):
        self.install()
        self.page.write_bytes(b'<html><head>Fresh conversion</head></html>')
        diagnose.cleanup(self.session)
        self.assertEqual(self.page.read_bytes(), b'<html><head>Fresh conversion</head></html>')

    def test_edited_client_is_preserved(self):
        self.install()
        client = self.bundle / diagnose.CLIENT_PATH
        client.write_text('// user edit')
        with self.assertRaisesRegex(ValueError, 'was edited'):
            diagnose.cleanup(self.session)
        self.assertEqual(client.read_text(), '// user edit')

    def test_refuses_duplicate_install_and_escaping_page_path(self):
        self.install()
        before = self.page.read_bytes()
        with self.assertRaisesRegex(ValueError, 'already installed'):
            self.install()
        self.assertEqual(self.page.read_bytes(), before)
        (self.bundle / 'Info.plist').write_bytes(plistlib.dumps(
            {'Chrome': {'Global Page': '../outside.html'}}))
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.install()


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.session = Path(self.temporary.name)
        for name in ('pending', 'dispatched'):
            (self.session / name).mkdir()
        diagnose.write_json(self.session / 'installation.json', {})
        self.server = diagnose.DiagnosticServer(self.session, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def endpoint(self, path):
        return '/' + self.server.token + '/' + path

    def test_authentication_and_routes(self):
        self.assertEqual(self.request('GET', '/wrong/poll')[0], 403)
        self.assertEqual(self.request('GET', self.endpoint('unknown'))[0], 404)
        self.assertEqual(self.request('OPTIONS', self.endpoint('poll'))[0], 200)

    def test_command_is_dispatched_once_even_when_a_client_reloads(self):
        script = self.session / 'probe.js'
        script.write_text('({answer: 42})', encoding='utf-8')
        with contextlib.redirect_stdout(io.StringIO()):
            diagnose.queue(argparse.Namespace(session=self.session, script=script))
        status, first = self.request('GET', self.endpoint('poll'))
        self.assertEqual(status, 200)
        self.assertEqual(first['jobs'][0]['code'], '({answer: 42})')
        self.assertEqual(self.request('GET', self.endpoint('poll'))[1]['jobs'], [])
        self.assertEqual(len(list((self.session / 'dispatched').glob('*.json'))), 1)

    def test_event_logging_and_bad_requests(self):
        batch = {'client': 'test', 'events': [{'type': 'result', 'value': 42}]}
        status, result = self.request('POST', self.endpoint('events'), json.dumps(batch))
        self.assertEqual((status, result), (200, {'ok': True}))
        event = json.loads((self.session / 'events.jsonl').read_text())
        self.assertEqual(event['event'], batch)
        self.assertEqual(self.request('POST', self.endpoint('events'), 'bad JSON')[0], 400)
        self.assertEqual(self.request('POST', self.endpoint('events'), '{}')[0], 400)
        self.assertEqual(self.request('POST', self.endpoint('events'), headers={
            'Content-Length': str(diagnose.MAX_BODY + 1)})[0], 413)

    def test_shutdown_stops_clients_without_dispatching_pending_commands(self):
        diagnose.write_json(self.session / 'pending' / '1.json', {'id': '1', 'code': '42'})
        self.server.stopping = True
        self.assertEqual(self.request('GET', self.endpoint('poll'))[1], {'jobs': [], 'stop': True})
        self.assertTrue((self.session / 'pending' / '1.json').exists())


if __name__ == '__main__':
    unittest.main()
