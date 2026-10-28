package com.jarvis.app

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.TimeUnit

class LlamaServer(private val context: Context) {
    @Volatile var port: Int = 8081
        private set
    @Volatile var lastError: String? = null
        private set

    private var process: Process? = null
    private val processLock = Any()
    private val logLock = Object()
    private val logs = ArrayDeque<String>()

    val isAlive: Boolean
        get() = synchronized(processLock) { process?.isAlive == true }

    fun start(model: File, projector: File?, settings: ServerSettings): Boolean {
        stop()
        lastError = null
        if (!model.isFile || model.length() <= 4) {
            lastError = "El modelo local no existe o está incompleto"
            return false
        }
        return try {
            val binary = File(context.applicationInfo.nativeLibraryDir, "libllama_server.so")
            if (!binary.isFile) {
                lastError = "No se incluyó el motor para esta arquitectura"
                Log.e(TAG, lastError!!)
                return false
            }
            val config = settings.sanitized()
            port = findAvailablePort()
            val command = mutableListOf(
                binary.absolutePath,
                "--model", model.absolutePath,
                "--port", port.toString(),
                "--host", "127.0.0.1",
                "--ctx-size", config.context.toString(),
                "--threads", config.threads.toString(),
                "--threads-batch", config.threads.toString(),
                "--batch-size", config.batch.toString(),
                "--ubatch-size", config.batch.coerceAtMost(64).toString(),
                "--parallel", "1",
                "--cache-type-k", "q8_0",
                "--cache-type-v", "q8_0",
                "--no-warmup",
                "--no-webui"
            )
            if (projector?.isFile == true) command.addAll(listOf("--mmproj", projector.absolutePath))
            if (config.rpcEnabled && config.rpcEndpoints.isNotEmpty()) {
                command.addAll(listOf("--rpc", config.rpcEndpoints.joinToString(",")))
            }

            Log.i(TAG, "Iniciando núcleo en puerto $port con ${config.threads} hilos y contexto ${config.context}")
            val builder = ProcessBuilder(command)
                .directory(context.filesDir)
                .redirectErrorStream(true)
            builder.environment()["LD_LIBRARY_PATH"] = context.applicationInfo.nativeLibraryDir
            builder.environment()["OMP_NUM_THREADS"] = config.threads.toString()
            val started = builder.start()
            synchronized(processLock) { process = started }
            startLogReader(started)
            true
        } catch (error: Exception) {
            lastError = error.message ?: "No se pudo iniciar llama-server"
            Log.e(TAG, "Error arrancando el núcleo", error)
            stop()
            false
        }
    }

    private fun startLogReader(activeProcess: Process) {
        Thread({
            try {
                BufferedReader(InputStreamReader(activeProcess.inputStream)).use { reader ->
                    var line = reader.readLine()
                    while (line != null) {
                        appendLog(line)
                        Log.d(TAG, line)
                        line = reader.readLine()
                    }
                }
            } catch (error: Exception) {
                if (activeProcess.isAlive) Log.w(TAG, "Lector de diagnóstico interrumpido", error)
            }
        }, "nova-llama-logs").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
            start()
        }
    }

    private fun appendLog(line: String) {
        synchronized(logLock) {
            logs.addLast(line.take(2000))
            while (logs.size > MAX_LOG_LINES) logs.removeFirst()
        }
    }

    fun snapshotLogs(maxLines: Int = 160): List<String> = synchronized(logLock) {
        logs.toList().takeLast(maxLines.coerceIn(1, MAX_LOG_LINES))
    }

    fun waitUntilReady(timeoutMs: Long = 120_000): Boolean {
        val startedAt = System.currentTimeMillis()
        while (System.currentTimeMillis() - startedAt < timeoutMs) {
            if (!isAlive) {
                lastError = snapshotLogs(8).lastOrNull() ?: "El motor terminó de forma inesperada"
                return false
            }
            try {
                val connection = URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = 1200
                    connection.readTimeout = 1200
                    connection.useCaches = false
                    if (connection.responseCode == HttpURLConnection.HTTP_OK) return true
                } finally {
                    connection.disconnect()
                }
            } catch (_: Exception) {
                // El puerto puede abrirse antes de terminar la carga del modelo.
            }
            Thread.sleep(350)
        }
        lastError = "Tiempo de espera agotado al cargar el modelo"
        return false
    }

    fun stop() {
        val active = synchronized(processLock) {
            val current = process
            process = null
            current
        } ?: return
        try {
            active.destroy()
            if (!active.waitFor(2, TimeUnit.SECONDS)) {
                active.destroyForcibly()
                active.waitFor(1, TimeUnit.SECONDS)
            }
        } catch (error: Exception) {
            Log.w(TAG, "Cierre forzado del núcleo", error)
            active.destroyForcibly()
        }
    }

    private fun findAvailablePort(): Int {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { socket ->
            socket.reuseAddress = true
            return socket.localPort
        }
    }

    companion object {
        private const val TAG = "NovaLlamaServer"
        private const val MAX_LOG_LINES = 300
    }
}
