"""Local, single-worker Demucs stem separation service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

STEMS = ('vocals', 'drums', 'bass', 'other')
ID_RE = re.compile(r'^[0-9a-f]{64}$')
MAX_SIZE = 60 * 1024 * 1024


def default_device():
    try:
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    except ImportError:
        return 'cpu'


class DemucsSeparator:
    def __init__(self, device):
        self.device = device
        self.separator = None
        self.api_checked = False
        self.progress = lambda value: None

    def separate(self, input_path, out_dir, on_progress):
        self.progress = on_progress
        if not self.api_checked:
            self.api_checked = True
            try:
                from demucs.api import Separator
            except ImportError:
                Separator = None
            if Separator is not None:
                self.separator = Separator(model='htdemucs', device=self.device,
                                           callback=self._callback)
        if self.separator is not None:
            import soundfile as sf
            _, sources = self.separator.separate_audio_file(str(input_path))
            for stem in STEMS:
                audio = sources[stem].detach().cpu().numpy()
                if audio.shape[0] == 1:
                    import numpy as np
                    audio = np.repeat(audio, 2, axis=0)
                sf.write(str(out_dir / (stem + '.wav')), audio.T,
                         self.separator.samplerate, subtype='PCM_16')
        else:
            # The CLI starts a fresh process per track; API mode reuses the model.
            cmd = [sys.executable, '-m', 'demucs', '-n', 'htdemucs', '-d',
                   self.device, '-o', str(out_dir / '_demucs'), str(input_path)]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding='utf-8', errors='replace')
            output = []
            for line in proc.stdout:
                output.append(line)
                for match in re.finditer(r'(\d+(?:\.\d+)?)\s*%', line):
                    on_progress(min(0.99, float(match.group(1)) / 100))
            if proc.wait():
                raise RuntimeError('Demucs failed: ' + ''.join(output)[-2000:])
            import soundfile as sf
            for stem in STEMS:
                source = out_dir / '_demucs' / 'htdemucs' / input_path.stem / (stem + '.wav')
                audio, rate = sf.read(str(source), dtype='float32', always_2d=True)
                if audio.shape[1] == 1:
                    import numpy as np
                    audio = np.repeat(audio, 2, axis=1)
                sf.write(str(out_dir / (stem + '.wav')), audio, rate, subtype='PCM_16')

    def _callback(self, info):
        # Demucs reports segment progress via these values.
        total = info.get('audio_length', 0)
        if total:
            self.progress(min(0.99, max(0.0, info.get('segment_offset', 0) / total)))


class StemService:
    def __init__(self, cache, device, separator):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.device = device
        self.separator = separator
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def complete(self, folder):
        return all((folder / (stem + '.wav')).is_file() for stem in STEMS)

    def submit(self, data, filename):
        ident = hashlib.sha256(data).hexdigest()
        folder = self.cache / ident
        with self.lock:
            if self.complete(folder):
                self.jobs[ident] = {'state': 'done', 'progress': 1.0, 'error': None}
                return ident, 'done'
            if ident in self.jobs and self.jobs[ident]['state'] in ('queued', 'running'):
                return ident, self.jobs[ident]['state']
            folder.mkdir(parents=True, exist_ok=True)
            ext = Path(filename).suffix.lower()
            if ext not in ('.m4a', '.mp3', '.wav', '.flac'):
                ext = '.audio'
            path = folder / ('input' + ext)
            path.write_bytes(data)
            self.jobs[ident] = {'state': 'queued', 'progress': 0.0, 'error': None}
            self.queue.put((ident, path, folder))
            return ident, 'queued'

    def status(self, ident):
        with self.lock:
            if ident in self.jobs:
                return dict(self.jobs[ident])
            if self.complete(self.cache / ident):
                return {'state': 'done', 'progress': 1.0, 'error': None}
        return None

    def _worker(self):
        while True:
            ident, path, folder = self.queue.get()
            try:
                with self.lock:
                    self.jobs[ident]['state'] = 'running'
                def progress(value):
                    with self.lock:
                        job = self.jobs[ident]
                        job['progress'] = max(job['progress'], min(0.99, max(0.0, float(value))))
                self.separator(path, folder, progress)
                if not self.complete(folder):
                    raise RuntimeError('Demucs did not produce all four stems')
                with self.lock:
                    self.jobs[ident].update(state='done', progress=1.0, error=None)
            except Exception as exc:
                # Partial results must never be mistaken for a completed cache entry.
                for stem in STEMS:
                    (folder / (stem + '.wav')).unlink(missing_ok=True)
                with self.lock:
                    self.jobs[ident].update(state='error', error=str(exc))
            finally:
                self.queue.task_done()


def make_server(host, port, cache, device, separator=None):
    service = StemService(cache, device, separator or DemucsSeparator(device).separate)

    class Handler(BaseHTTPRequestHandler):
        def cors(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Filename')

        def respond(self, status, payload):
            body = json.dumps(payload).encode('utf-8')
            self.send_response(status)
            self.cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.send_header('Content-Length', '0')
            self.end_headers()

        def do_POST(self):
            if urlsplit(self.path).path != '/separate':
                return self.respond(404, {'error': 'Not found'})
            try:
                length = int(self.headers.get('Content-Length', ''))
            except ValueError:
                return self.respond(400, {'error': 'Invalid Content-Length'})
            if length <= 0 or length > MAX_SIZE:
                return self.respond(400, {'error': 'Audio must be between 1 byte and 60 MB'})
            data = self.rfile.read(length)
            if len(data) != length:
                return self.respond(400, {'error': 'Incomplete upload'})
            ident, state = service.submit(data, unquote(self.headers.get('X-Filename', '')))
            self.respond(200, {'id': ident, 'state': state})

        def do_GET(self):
            parts = unquote(urlsplit(self.path).path).split('/')
            if parts == ['', 'health']:
                return self.respond(200, {'ok': True, 'model': 'htdemucs', 'device': device})
            if len(parts) == 3 and parts[1] == 'status' and ID_RE.fullmatch(parts[2]):
                status = service.status(parts[2])
                if status is not None:
                    return self.respond(200, {'id': parts[2], **status})
            if (len(parts) == 4 and parts[1] == 'stems' and ID_RE.fullmatch(parts[2])
                    and parts[3] in tuple(s + '.wav' for s in STEMS)):
                path = service.cache / parts[2] / parts[3]
                # Only expose completed jobs, never partially written output.
                status = service.status(parts[2])
                if status and status['state'] == 'done' and path.is_file():
                    with path.open('rb') as f:
                        self.send_response(200)
                        self.cors()
                        self.send_header('Content-Type', 'audio/wav')
                        self.send_header('Content-Length', str(os.fstat(f.fileno()).st_size))
                        self.end_headers()
                        while chunk := f.read(65536):
                            self.wfile.write(chunk)
                    return
            self.respond(404, {'error': 'Not found'})

    server = ThreadingHTTPServer((host, port), Handler)
    server.service = service
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--cache', default=r'D:\MotionDJ-ia\cache')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default=None)
    args = parser.parse_args()
    device = args.device or default_device()
    server = make_server(args.host, args.port, args.cache, device)
    print(f'MotionDJ stems server: http://{args.host}:{args.port} ({device})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
