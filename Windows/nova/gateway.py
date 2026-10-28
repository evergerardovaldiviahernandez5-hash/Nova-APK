from __future__ import annotations

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import threading
from typing import Any
from urllib.parse import unquote, urlsplit

from .engine import LlamaProcess

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/svg+xml", ".svg")


class NovaHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], engine: LlamaProcess, ui_directory: Path) -> None:
        self.engine = engine
        self.ui_directory = ui_directory.resolve()
        super().__init__(address, NovaRequestHandler)


class NovaRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NovaLocal/2.0"
    sys_version = ""
    server: NovaHTTPServer

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/nova/status":
            self._json(200, self.server.engine.status())
        elif path == "/nova/logs":
            self._json(200, {"logs": self.server.engine.logs()})
        elif path == "/health" or path.startswith("/v1/") or path == "/props":
            self._proxy()
        else:
            self._static(path)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/v1/") or path in {"/completion", "/embeddings", "/tokenize", "/detokenize"}:
            self._proxy()
        else:
            self._json(404, {"error": "Ruta local no encontrada."})

    def do_HEAD(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._proxy()
        else:
            self._static(path, head_only=True)

    def _static(self, path: str, head_only: bool = False) -> None:
        relative = {"/": "index.html", "/index.html": "index.html"}.get(path, path.lstrip("/"))
        if not relative or ".." in Path(relative).parts or relative.startswith(("/", "\\")):
            self._json(403, {"error": "Ruta no permitida."})
            return
        allowed = relative in {"index.html", "app.css", "app.js", "store.js", "matrix.js"} or relative.startswith("assets/")
        if not allowed:
            self._json(404, {"error": "Recurso no encontrado."})
            return
        candidate = (self.server.ui_directory / relative).resolve()
        if not candidate.is_relative_to(self.server.ui_directory) or not candidate.is_file():
            self._json(404, {"error": "Recurso no encontrado."})
            return
        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json", "image/svg+xml"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self._common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head_only:
            self.wfile.write(content)

    def _proxy(self) -> None:
        if not self.server.engine.is_alive:
            self._json(503, {"error": {"message": "El núcleo local no está listo.", "code": "engine_not_ready"}})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > 64 * 1024 * 1024:
            self._json(413, {"error": "La solicitud supera el límite local de 64 MB."})
            return
        body = self.rfile.read(length) if length else None
        connection = http.client.HTTPConnection("127.0.0.1", self.server.engine.port, timeout=1800)
        headers = {
            key: value for key, value in self.headers.items()
            if key.lower() in {"content-type", "accept", "authorization"}
        }
        response_started = False
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            self.send_response(response.status)
            self._common_headers()
            content_length = response.getheader("Content-Length")
            content_type = response.getheader("Content-Type") or "application/octet-stream"
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            if content_length is not None:
                self.send_header("Content-Length", content_length)
            else:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            response_started = True
            if self.command != "HEAD":
                while True:
                    chunk = response.read(16 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (OSError, http.client.HTTPException) as error:
            if not response_started and not self.wfile.closed:
                try:
                    self._json(502, {"error": {"message": f"El núcleo no respondió: {error}"}})
                except (BrokenPipeError, ConnectionResetError):
                    pass
        finally:
            connection.close()

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _common_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def log_message(self, format: str, *args: Any) -> None:
        # Avoid leaking prompts through default HTTP request logging.
        return


class NovaGateway:
    def __init__(self, engine: LlamaProcess, ui_directory: Path) -> None:
        self.server = NovaHTTPServer(("127.0.0.1", 0), engine, ui_directory)
        self.thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/index.html"

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.2}, name="nova-gateway", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        if self.thread:
            self.thread.join(timeout=2)
