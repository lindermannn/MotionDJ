import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import wave

spec = importlib.util.spec_from_file_location('stems_server', Path(__file__).with_name('server.py'))
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.release = threading.Event()
        def fake(input_path, out_dir, on_progress):
            self.release.wait(5)
            on_progress(0.5)
            for name in server_module.STEMS:
                with wave.open(str(out_dir / (name + '.wav')), 'wb') as wav:
                    wav.setnchannels(2)
                    wav.setsampwidth(2)
                    wav.setframerate(44100)
                    wav.writeframes(b'\0' * 400)
        self.server = server_module.make_server('127.0.0.1', 0, self.temp.name, 'cpu', fake)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.release.set()
        self.server.service.queue.join()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        conn.close()
        return result

    def test_health_and_cors(self):
        status, headers, body = self.request('GET', '/health')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'ok': True, 'model': 'htdemucs', 'device': 'cpu'})
        self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
        status, headers, _ = self.request('OPTIONS', '/separate')
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS')
        self.assertEqual(headers['Access-Control-Allow-Headers'], 'Content-Type, X-Filename')

    def test_separate_download_and_cache(self):
        audio = b'fake audio file'
        ident = hashlib.sha256(audio).hexdigest()
        status, _, body = self.request('POST', '/separate', audio, {'X-Filename': 'test%20song.mp3'})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'id': ident, 'state': 'queued'})
        _, _, body = self.request('GET', '/status/' + ident)
        self.assertIn(json.loads(body)['state'], ('queued', 'running'))
        self.release.set()
        deadline = time.monotonic() + 5
        while True:
            _, _, body = self.request('GET', '/status/' + ident)
            job = json.loads(body)
            if job['state'] in ('done', 'error') or time.monotonic() > deadline:
                break
            time.sleep(0.01)
        self.assertEqual(job, {'id': ident, 'state': 'done', 'progress': 1.0, 'error': None})
        for stem in server_module.STEMS:
            status, headers, body = self.request('GET', f'/stems/{ident}/{stem}.wav')
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], 'audio/wav')
            self.assertEqual(int(headers['Content-Length']), len(body))
            self.assertTrue(body.startswith(b'RIFF'))
        _, _, body = self.request('POST', '/separate', audio)
        self.assertEqual(json.loads(body), {'id': ident, 'state': 'done'})

    def test_invalid_paths(self):
        for path in ('/status/not-an-id', '/status/' + 'a' * 64,
                     '/stems/../../server.py', '/stems/%2e%2e/server.py',
                     '/stems/' + 'a' * 64 + '/%2e%2e%2finput.wav',
                     '/stems/' + 'a' * 64 + '/unknown.wav'):
            with self.subTest(path=path):
                status, headers, body = self.request('GET', path)
                self.assertEqual(status, 404)
                self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
                self.assertIn('error', json.loads(body))


if __name__ == '__main__':
    unittest.main()
