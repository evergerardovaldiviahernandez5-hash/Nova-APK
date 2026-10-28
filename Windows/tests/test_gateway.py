from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

from nova.gateway import NovaGateway


class FakeEngine:
    def __init__(self, port=1, alive=False):
        self.port = port
        self.is_alive = alive

    def status(self):
        return {"ready": self.is_alive, "settings": {"context": 1024}, "modelName": "test.gguf"}

    def logs(self):
        return "test-log"


class StreamingHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b'data: {"choices":[{"delta":{"content":"Hola"}}]}\n\n')
        self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True

    def log_message(self, *args):
        pass


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ui = Path(__file__).resolve().parents[2] / "app" / "src" / "main" / "assets" / "ui"

    def test_static_ui_status_and_missing_engine(self):
        gateway = NovaGateway(FakeEngine(), self.ui)
        gateway.start()
        try:
            with urlopen(gateway.url) as response:
                self.assertIn(b"NOVA", response.read())
            status_url = gateway.url.replace("/index.html", "/nova/status")
            with urlopen(status_url) as response:
                self.assertEqual(json.load(response)["modelName"], "test.gguf")
            with self.assertRaises(HTTPError) as error:
                urlopen(gateway.url.replace("/index.html", "/v1/chat/completions"))
            self.assertEqual(error.exception.code, 503)
        finally:
            gateway.stop()

    def test_streaming_proxy_forwards_complete_sse(self):
        backend = ThreadingHTTPServer(("127.0.0.1", 0), StreamingHandler)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        gateway = NovaGateway(FakeEngine(backend.server_port, True), self.ui)
        gateway.start()
        try:
            url = gateway.url.replace("/index.html", "/v1/chat/completions")
            with urlopen(url, data=b"{}", timeout=5) as response:
                payload = response.read()
            self.assertIn(b"Hola", payload)
            self.assertIn(b"[DONE]", payload)
        finally:
            gateway.stop()
            backend.shutdown()
            backend.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
