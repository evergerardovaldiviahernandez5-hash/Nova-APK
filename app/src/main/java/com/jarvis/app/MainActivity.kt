package com.jarvis.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import java.io.ByteArrayInputStream
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var overlay: LinearLayout
    private lateinit var loading: ProgressBar
    private lateinit var statusText: TextView
    private lateinit var pickButton: Button
    private lateinit var llmServer: LlamaServer

    @Volatile private var serverReady = false
    private var startJob: Job? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingExport: String? = null

    private val pickModel = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { importModel(it, ModelManager.Kind.MODEL) }
    }
    private val pickProjector = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { importModel(it, ModelManager.Kind.PROJECTOR) }
    }
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        fileChooserCallback?.onReceiveValue(uris)
        fileChooserCallback = null
    }
    private val exportDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        val content = pendingExport
        pendingExport = null
        if (uri == null || content == null) return@registerForActivityResult
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                contentResolver.openOutputStream(uri, "wt")?.bufferedWriter()?.use { it.write(content) }
                    ?: throw IllegalStateException("No se pudo abrir el destino")
                withContext(Dispatchers.Main) { Toast.makeText(this@MainActivity, "Conversación exportada", Toast.LENGTH_SHORT).show() }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) { Toast.makeText(this@MainActivity, error.message, Toast.LENGTH_LONG).show() }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.statusBarColor = Color.rgb(5, 10, 8)
        window.navigationBarColor = Color.rgb(5, 10, 8)

        webView = findViewById(R.id.webView)
        overlay = findViewById(R.id.overlay)
        loading = findViewById(R.id.progressBar)
        statusText = findViewById(R.id.statusText)
        pickButton = findViewById(R.id.pickModelBtn)
        llmServer = LlamaServer(this)

        configureWebView()
        pickButton.setOnClickListener { pickModel.launch(arrayOf("*/*")) }
        findViewById<Button>(R.id.pickProjectorBtn).setOnClickListener { pickProjector.launch(arrayOf("*/*")) }

        val saved = ModelManager.getSavedModel(this)
        if (saved != null) startServer()
        else showSetup("Selecciona un modelo .gguf para empezar", loadingVisible = false)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.setBackgroundColor(Color.rgb(5, 10, 8))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            builtInZoomControls = false
            displayZoomControls = false
            safeBrowsingEnabled = true
        }
        webView.addJavascriptInterface(NovaBridge(this), "NovaBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val url = request?.url ?: return null
                if (request.method != "GET" || url.host != "127.0.0.1") return null
                val path = url.path ?: "/"
                if (path == "/nova/status") return jsonResponse(bootstrapJson())
                val assetPath = when (path) {
                    "/", "/index.html" -> "ui/index.html"
                    "/app.css", "/app.js", "/store.js", "/matrix.js" -> "ui$path"
                    else -> if (path.startsWith("/assets/") && !path.contains("..")) "ui$path" else return null
                }
                return try {
                    val encoding = if (assetPath.endsWith(".webp") || assetPath.endsWith(".woff2")) null else "UTF-8"
                    WebResourceResponse(mimeFor(assetPath), encoding, assets.open(assetPath))
                } catch (error: Exception) {
                    Log.w(TAG, "Recurso local no encontrado: $assetPath")
                    null
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.host == "127.0.0.1") return false
                openExternal(url.toString())
                return true
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: android.webkit.WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    serverReady = false
                    showSetup("Se interrumpió la conexión con el núcleo local", loadingVisible = false)
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    val intent = params?.createIntent() ?: Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    fileChooser.launch(intent)
                    true
                } catch (error: ActivityNotFoundException) {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = null
                    false
                }
            }

            override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                if (message != null) Log.d("NovaWeb", "${message.message()} [${message.sourceId()}:${message.lineNumber()}]")
                return true
            }
        }
    }

    private fun mimeFor(path: String): String = when (path.substringAfterLast('.', "")) {
        "html" -> "text/html"
        "css" -> "text/css"
        "js" -> "application/javascript"
        "svg" -> "image/svg+xml"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        "json" -> "application/json"
        else -> "application/octet-stream"
    }

    private fun jsonResponse(json: String): WebResourceResponse = WebResourceResponse(
        "application/json", "UTF-8", ByteArrayInputStream(json.toByteArray(Charsets.UTF_8))
    )

    private fun importModel(uri: Uri, kind: ModelManager.Kind) {
        lifecycleScope.launch {
            showSetup(if (kind == ModelManager.Kind.MODEL) "Validando y copiando el modelo…" else "Validando el proyector multimodal…")
            try {
                withContext(Dispatchers.IO) { ModelManager.copyToInternal(this@MainActivity, uri, kind) }
                if (kind == ModelManager.Kind.PROJECTOR && ModelManager.getSavedModel(this@MainActivity) == null) {
                    showSetup("Proyector guardado. Ahora selecciona el modelo GGUF", loadingVisible = false)
                } else startServer()
            } catch (error: Exception) {
                showSetup(error.message ?: "No se pudo importar el archivo", loadingVisible = false)
            }
        }
    }

    private fun showSetup(message: String, loadingVisible: Boolean = true) {
        runOnUiThread {
            overlay.visibility = View.VISIBLE
            webView.visibility = View.GONE
            loading.visibility = if (loadingVisible) View.VISIBLE else View.GONE
            pickButton.visibility = if (loadingVisible) View.GONE else View.VISIBLE
            findViewById<Button>(R.id.pickProjectorBtn).visibility = if (loadingVisible) View.GONE else View.VISIBLE
            statusText.text = message
        }
    }

    private fun startServer() {
        if (startJob?.isActive == true) return
        startJob = lifecycleScope.launch {
            serverReady = false
            showSetup("Cargando el núcleo Nova…")
            val model = ModelManager.getSavedModel(this@MainActivity)
            if (model == null) {
                showSetup("Selecciona un modelo .gguf para empezar", loadingVisible = false)
                return@launch
            }
            val projector = ModelManager.getSavedProjector(this@MainActivity)
            val settings = ServerSettings.load(this@MainActivity)
            val ready = withContext(Dispatchers.IO) {
                llmServer.start(model, projector, settings) && llmServer.waitUntilReady()
            }
            if (ready) {
                serverReady = true
                overlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
                webView.loadUrl("http://127.0.0.1:${llmServer.port}/index.html")
            } else {
                showSetup(llmServer.lastError ?: "No se pudo iniciar. Prueba otro modelo .gguf", loadingVisible = false)
            }
        }
    }

    fun selectModelFromWeb(): String {
        runOnUiThread { pickModel.launch(arrayOf("*/*")) }
        return ACCEPTED
    }

    fun selectProjectorFromWeb(): String {
        runOnUiThread { pickProjector.launch(arrayOf("*/*")) }
        return ACCEPTED
    }

    fun applySettingsFromWeb(raw: String): String {
        return try {
            val settings = ServerSettings.fromJson(this, raw)
            ServerSettings.save(this, settings)
            runOnUiThread { startServer() }
            ACCEPTED
        } catch (error: Exception) {
            JSONObject().put("accepted", false).put("error", error.message).toString()
        }
    }

    fun bootstrapJson(): String {
        val model = ModelManager.getSavedModel(this)
        val projector = ModelManager.getSavedProjector(this)
        val settings = ServerSettings.load(this)
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(memory)
        val root = JSONObject()
            .put("platform", "android")
            .put("ready", serverReady && llmServer.isAlive)
            .put("modelName", model?.let { ModelManager.getDisplayName(this, ModelManager.Kind.MODEL) } ?: JSONObject.NULL)
            .put("modelSize", model?.let { ModelManager.formatBytes(it.length()) } ?: JSONObject.NULL)
            .put("mmprojName", projector?.let { ModelManager.getDisplayName(this, ModelManager.Kind.PROJECTOR) } ?: JSONObject.NULL)
            .put("mmprojReady", projector != null)
            .put("memoryAvailableMB", memory.availMem / (1024 * 1024))
            .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            .put("port", llmServer.port)
            .put("settings", settings.toJson())
        return root.toString()
    }

    fun nativeLogs(): String = llmServer.snapshotLogs().joinToString("\n").ifBlank {
        "Todavía no hay registros del núcleo."
    }

    fun shareText(text: String) {
        runOnUiThread {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text.take(200_000))
            }
            startActivity(Intent.createChooser(intent, "Compartir desde Nova"))
        }
    }

    fun exportText(filename: String, content: String) {
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._-]"), "-").take(80).ifBlank { "nova.md" }
        pendingExport = content
        runOnUiThread { exportDocument.launch(safeName) }
    }

    fun openExternal(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        runOnUiThread {
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            catch (error: ActivityNotFoundException) { Toast.makeText(this, "No hay un navegador disponible", Toast.LENGTH_SHORT).show() }
        }
    }

    override fun onDestroy() {
        serverReady = false
        startJob?.cancel()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("NovaBridge")
            webView.destroy()
        }
        if (::llmServer.isInitialized) llmServer.stop()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "NovaMainActivity"
        private const val ACCEPTED = "{\"accepted\":true}"
    }
}
