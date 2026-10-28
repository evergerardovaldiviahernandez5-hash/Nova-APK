package com.jarvis.app

import android.app.ActivityManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Validated native inference settings. UI-only preferences are deliberately excluded. */
data class ServerSettings(
    val context: Int = 2048,
    val threads: Int = 2,
    val batch: Int = 64,
    val rpcEnabled: Boolean = false,
    val rpcEndpoints: List<String> = emptyList()
) {
    fun sanitized(): ServerSettings {
        val validNodes = rpcEndpoints.map { it.trim() }
            .filter { NODE_REGEX.matches(it) }
            .filter { it.substringAfterLast(':').toIntOrNull() in 1..65535 }
            .distinct()
            .take(8)
        return copy(
            context = context.coerceIn(512, 8192),
            threads = threads.coerceIn(1, 16),
            batch = batch.coerceIn(32, 512),
            rpcEnabled = rpcEnabled && validNodes.isNotEmpty(),
            rpcEndpoints = validNodes
        )
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("context", context)
        put("threads", threads)
        put("batch", batch)
        put("rpcEnabled", rpcEnabled)
        put("rpcEndpoints", JSONArray(rpcEndpoints))
    }

    companion object {
        private const val PREFS = "nova_server_settings"
        private val NODE_REGEX = Regex("^[a-zA-Z0-9.-]+:[0-9]{1,5}$")
        private val ALLOWED_CONTEXTS = intArrayOf(512, 1024, 2048, 4096, 8192)
        private val ALLOWED_BATCHES = intArrayOf(32, 64, 128, 256, 512)

        fun defaults(context: Context): ServerSettings {
            val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            val lowMemoryDevice = info.totalMem <= 3L * 1024 * 1024 * 1024
            return ServerSettings(
                context = if (lowMemoryDevice) 1024 else 2048,
                threads = Runtime.getRuntime().availableProcessors().coerceIn(1, 4),
                batch = if (lowMemoryDevice) 32 else 64
            ).sanitized()
        }

        fun load(context: Context): ServerSettings {
            val defaults = defaults(context)
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val nodes = mutableListOf<String>()
            val rawNodes = prefs.getString("rpc_endpoints", "") ?: ""
            rawNodes.split(',', '\n').mapTo(nodes) { it.trim() }
            return ServerSettings(
                context = prefs.getInt("context", defaults.context),
                threads = prefs.getInt("threads", defaults.threads),
                batch = prefs.getInt("batch", defaults.batch),
                rpcEnabled = prefs.getBoolean("rpc_enabled", false),
                rpcEndpoints = nodes.filter { it.isNotEmpty() }
            ).sanitized()
        }

        fun fromJson(context: Context, raw: String): ServerSettings {
            val current = load(context)
            val json = JSONObject(raw)
            val nodes = mutableListOf<String>()
            val array = json.optJSONArray("rpcEndpoints")
            if (array != null) {
                for (index in 0 until array.length()) nodes.add(array.optString(index))
            } else {
                json.optString("rpcEndpoints").split(',', '\n').mapTo(nodes) { it.trim() }
            }
            val candidate = ServerSettings(
                context = json.optInt("context", current.context),
                threads = json.optInt("threads", current.threads),
                batch = json.optInt("batch", current.batch),
                rpcEnabled = json.optBoolean("rpcEnabled", current.rpcEnabled),
                rpcEndpoints = nodes.ifEmpty { current.rpcEndpoints }
            ).sanitized()
            require(candidate.context in ALLOWED_CONTEXTS) { "Contexto no admitido" }
            require(candidate.batch in ALLOWED_BATCHES) { "Lote no admitido" }
            require(!candidate.rpcEnabled || candidate.rpcEndpoints.isNotEmpty()) { "Faltan nodos RPC" }
            return candidate
        }

        fun save(context: Context, settings: ServerSettings) {
            val value = settings.sanitized()
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("context", value.context)
                .putInt("threads", value.threads)
                .putInt("batch", value.batch)
                .putBoolean("rpc_enabled", value.rpcEnabled)
                .putString("rpc_endpoints", value.rpcEndpoints.joinToString(","))
                .apply()
        }
    }
}
