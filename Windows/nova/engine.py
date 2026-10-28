from __future__ import annotations

from collections import deque
import logging
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from typing import Any
from urllib.request import urlopen

from .config import NovaConfig, resource_path, validate_gguf

LOGGER = logging.getLogger("nova.engine")


class LlamaProcess:
    def __init__(self, config: NovaConfig) -> None:
        self.config = config
        self.port = 8081
        self._process: subprocess.Popen[bytes] | None = None
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None
        self._logs: deque[str] = deque(maxlen=300)
        self._state = "idle"
        self._last_error: str | None = None

    @property
    def binary_path(self) -> Path:
        override = os.environ.get("NOVA_LLAMA_SERVER")
        if override:
            return Path(override).expanduser().resolve()
        executable = "llama-server.exe" if os.name == "nt" else "llama-server"
        return resource_path("runtime", executable)

    @property
    def is_alive(self) -> bool:
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def start_async(self) -> bool:
        with self._lock:
            if self._worker and self._worker.is_alive():
                return False
            self._state = "loading"
            self._last_error = None
            self._worker = threading.Thread(target=self._restart_worker, name="nova-engine", daemon=True)
            self._worker.start()
            return True

    def _restart_worker(self) -> None:
        try:
            self.stop()
            model = validate_gguf(self.config.model)
            projector = validate_gguf(self.config.mmproj) if self.config.mmproj else None
            self._launch(model, projector)
            if self.wait_until_ready():
                with self._lock:
                    self._state = "ready"
                return
            raise RuntimeError(self._last_error or "Tiempo de espera agotado al cargar el modelo.")
        except Exception as error:  # The error is surfaced in the native status endpoint.
            LOGGER.exception("No se pudo iniciar el núcleo")
            with self._lock:
                self._state = "error"
                self._last_error = str(error)
            self.stop()

    def _launch(self, model: Path, projector: Path | None) -> None:
        binary = self.binary_path
        if not binary.is_file():
            raise FileNotFoundError(f"No se encontró el motor llama-server en {binary}")
        settings = self.config.settings
        self.port = self._available_port()
        command = [
            str(binary), "--model", str(model), "--host", "127.0.0.1", "--port", str(self.port),
            "--ctx-size", str(settings["context"]), "--threads", str(settings["threads"]),
            "--threads-batch", str(settings["threads"]), "--batch-size", str(settings["batch"]),
            "--ubatch-size", str(min(settings["batch"], 64)), "--parallel", "1",
            "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--no-warmup", "--no-webui",
        ]
        if projector:
            command.extend(["--mmproj", str(projector)])
        if settings["rpcEnabled"]:
            command.extend(["--rpc", ",".join(settings["rpcEndpoints"])])

        environment = os.environ.copy()
        environment["OMP_NUM_THREADS"] = str(settings["threads"])
        environment["PATH"] = str(binary.parent) + os.pathsep + environment.get("PATH", "")
        flags = 0x08000000 | 0x00000200 if os.name == "nt" else 0  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        process = subprocess.Popen(
            command, cwd=binary.parent, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags,
            shell=False,
        )
        with self._lock:
            self._process = process
        threading.Thread(target=self._read_logs, args=(process,), name="nova-engine-logs", daemon=True).start()
        LOGGER.info("Núcleo iniciado en 127.0.0.1:%s", self.port)

    def _read_logs(self, process: subprocess.Popen[bytes]) -> None:
        if process.stdout is None:
            return
        try:
            for raw in iter(process.stdout.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip()[:2000]
                self._logs.append(line)
                LOGGER.debug("llama-server: %s", line)
        except (OSError, ValueError):
            if process.poll() is None:
                LOGGER.warning("Lector de diagnóstico interrumpido")

    def wait_until_ready(self, timeout: float = 120.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.is_alive:
                self._last_error = self.logs(8).splitlines()[-1] if self._logs else "El motor terminó de forma inesperada."
                return False
            try:
                with urlopen(f"http://127.0.0.1:{self.port}/health", timeout=1.2) as response:
                    if response.status == 200:
                        return True
            except OSError:
                pass
            time.sleep(0.35)
        self._last_error = "Tiempo de espera agotado al cargar el modelo."
        return False

    def stop(self) -> None:
        with self._lock:
            process = self._process
            self._process = None
        if not process or process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        except OSError:
            process.kill()

    def logs(self, limit: int = 160) -> str:
        values = list(self._logs)[-max(1, min(limit, 300)):]
        return "\n".join(values) if values else "Todavía no hay registros del núcleo."

    def status(self) -> dict[str, Any]:
        status = self.config.bootstrap()
        with self._lock:
            status.update({
                "ready": self._state == "ready" and self.is_alive,
                "engineState": self._state,
                "lastError": self._last_error,
                "port": self.port,
            })
        return status

    @staticmethod
    def _available_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])
