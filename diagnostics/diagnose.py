#!/usr/bin/env python3
"""Temporary, loopback-only diagnostics for a converted Safari extension."""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
CLIENT_PATH = Path('wex/wex-local-diagnostics.js')
START = b'<!-- wex-local-diagnostics:start -->'
END = b'<!-- wex-local-diagnostics:end -->\n'
MAX_BODY = 2_000_000


def write_json(path, data):
    temporary = path.with_name(path.name + '.' + secrets.token_hex(4) + '.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def inside(bundle, relative):
    path = (bundle / relative).resolve()
    if bundle not in path.parents:
        raise ValueError('Bundle file escapes its directory: ' + str(relative))
    return path


def install(bundle, session, endpoint):
    """Inject one marked script tag; save enough to clean up after a crash."""
    bundle = bundle.resolve()
    info = plistlib.loads((bundle / 'Info.plist').read_bytes())
    page = inside(bundle, info['Chrome']['Global Page'])
    client = inside(bundle, CLIENT_PATH)
    original = page.read_bytes()
    if START in original or client.exists():
        raise ValueError('Diagnostics already installed; clean up the previous session first')
    # The tag goes at the end of the head; a page that leaves its head and
    # body tags out, as HTML allows, gets it at the end of the document.
    closing = (re.search(br'</head\s*>', original, re.I) or
               re.search(br'</body\s*>', original, re.I) or
               re.search(br'</html\s*>', original, re.I) or
               re.search(br'$', original))
    source = (ROOT / 'client.js').read_text(encoding='utf-8')
    source = source.replace('__ENDPOINT__', json.dumps(endpoint))
    relative = os.path.relpath(str(client), str(page.parent)).replace(os.sep, '/')
    tag = ('\n<script src="' + html.escape(relative, quote=True) + '"></script>\n').encode('utf-8')
    block = START + tag + END
    state = {'bundle': str(bundle), 'page': str(page), 'client': str(client),
             'block': block.decode('utf-8'),
             'client_sha256': hashlib.sha256(source.encode('utf-8')).hexdigest()}
    (session / 'original-global-page.html').write_bytes(original)
    write_json(session / 'installation.json', state)
    client.parent.mkdir(parents=True, exist_ok=True)
    try:
        client.write_text(source, encoding='utf-8')
        page.write_bytes(original[:closing.start()] + block + original[closing.start():])
    except Exception:
        cleanup(session)
        raise


def cleanup(session):
    """Remove only our tag/file, preserving later edits or a new conversion."""
    path = session / 'installation.json'
    if not path.exists():
        return
    state = json.loads(path.read_text(encoding='utf-8'))
    bundle = Path(state['bundle']).resolve()
    page = inside(bundle, state['page'])
    client = inside(bundle, state['client'])
    if page.exists():
        current = page.read_bytes()
        block = state['block'].encode('utf-8')
        if block in current:
            page.write_bytes(current.replace(block, b'', 1))
    if client.exists():
        if hashlib.sha256(client.read_bytes()).hexdigest() != state['client_sha256']:
            raise ValueError('Diagnostic client was edited; inspect it before removing: ' + str(client))
        client.unlink()
    state['cleaned_at'] = time.time()
    write_json(path, state)


class DiagnosticServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, session, port):
        self.session = session
        self.token = secrets.token_urlsafe(24)
        self.lock = threading.Lock()
        self.stopping = False
        super().__init__(('127.0.0.1', port), Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, data):
        raw = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def route(self):
        parts = urlsplit(self.path).path.split('/')
        if len(parts) != 3 or not secrets.compare_digest(parts[1].encode('utf-8'), self.server.token.encode('ascii')):
            return None
        return parts[2]

    def do_OPTIONS(self):
        self.reply(200 if self.route() else 403, {})

    def do_GET(self):
        route = self.route()
        if route != 'poll':
            return self.reply(403 if route is None else 404, {})
        jobs = []
        with self.server.lock:
            if not self.server.stopping:
                pending = sorted((self.server.session / 'pending').glob('*.json'))
                if pending:
                    path = pending[0]
                    job = json.loads(path.read_text(encoding='utf-8'))
                    # Claim before delivery: a global-page reload must never
                    # replay a command that may already have changed state.
                    path.replace(self.server.session / 'dispatched' / path.name)
                    jobs.append(job)
        self.reply(200, {'jobs': jobs, 'stop': self.server.stopping})

    def do_POST(self):
        route = self.route()
        if route != 'events':
            return self.reply(403 if route is None else 404, {})
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.reply(400, {})
        if size <= 0 or size > MAX_BODY:
            return self.reply(413, {})
        self.connection.settimeout(10)
        try:
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict) or not isinstance(data.get('events'), list):
                raise ValueError('Expected an event batch')
        except (ValueError, UnicodeError, OSError):
            return self.reply(400, {})
        with self.server.lock:
            with (self.server.session / 'events.jsonl').open('a', encoding='utf-8') as handle:
                handle.write(json.dumps({'at': time.time(), 'event': data}) + '\n')
        self.reply(200, {'ok': True})


def serve(args):
    session = args.session.resolve()
    session.mkdir(parents=True, exist_ok=False)
    session.chmod(0o700)
    for name in ('pending', 'dispatched'):
        (session / name).mkdir()
    (session / 'events.jsonl').touch()
    server = DiagnosticServer(session, args.port)
    port = server.server_address[1]
    endpoint = 'http://127.0.0.1:%d/%s' % (port, server.token)
    try:
        install(args.bundle, session, endpoint)
        print('Session: ' + str(session), flush=True)
        print('Listening on 127.0.0.1:%d. Reload the extension once in Builder.' % port, flush=True)
        print('Ctrl-C stops the client and removes the diagnostic files.', flush=True)
        try:
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            # Give the serial polling client a chance to receive a stop
            # response before the listener closes. No browser automation.
            server.stopping = True
            server.timeout = 0.25
            deadline = time.monotonic() + 3
            try:
                while time.monotonic() < deadline:
                    server.handle_request()
            except KeyboardInterrupt:
                pass
    finally:
        server.server_close()
        cleanup(session)
        print('Diagnostics removed. Logs remain in ' + str(session), flush=True)


def queue(args):
    if not (args.session / 'installation.json').exists():
        raise ValueError('Not a diagnostic session: ' + str(args.session))
    state = json.loads((args.session / 'installation.json').read_text(encoding='utf-8'))
    if 'cleaned_at' in state:
        raise ValueError('This session has ended; start a fresh server session')
    job_id = '%020d-%s' % (time.time_ns(), secrets.token_hex(4))
    job = {'id': job_id, 'name': args.script.name,
           'code': args.script.read_text(encoding='utf-8')}
    write_json(args.session / 'pending' / (job_id + '.json'), job)
    print(job_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    start = commands.add_parser('serve', help='start a session and temporarily instrument a bundle')
    start.add_argument('bundle', type=Path)
    start.add_argument('--session', type=Path,
                       default=ROOT / 'sessions' / (time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(2)))
    start.add_argument('--port', type=int, default=8765)
    start.set_defaults(run=serve)
    enqueue = commands.add_parser('queue', help='run a JavaScript expression once on the global page')
    enqueue.add_argument('session', type=Path)
    enqueue.add_argument('script', type=Path)
    enqueue.set_defaults(run=queue)
    remove = commands.add_parser('cleanup', help='remove instrumentation left by an interrupted server')
    remove.add_argument('session', type=Path)
    remove.set_defaults(run=lambda args: cleanup(args.session))
    args = parser.parse_args()
    try:
        args.run(args)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, 'Error: %s\n' % error)


if __name__ == '__main__':
    main()
