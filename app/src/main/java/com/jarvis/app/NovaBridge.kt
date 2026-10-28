package com.jarvis.app

import android.webkit.JavascriptInterface

/** Narrow native surface exposed only to Nova's loopback UI. */
class NovaBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun getBootstrap(): String = activity.bootstrapJson()

    @JavascriptInterface
    fun selectModel(): String = activity.selectModelFromWeb()

    @JavascriptInterface
    fun selectProjector(): String = activity.selectProjectorFromWeb()

    @JavascriptInterface
    fun applySettings(settings: String): String = activity.applySettingsFromWeb(settings)

    @JavascriptInterface
    fun getLogs(): String = activity.nativeLogs()

    @JavascriptInterface
    fun shareText(text: String): String {
        activity.shareText(text)
        return "{\"accepted\":true}"
    }

    @JavascriptInterface
    fun exportText(filename: String, content: String): String {
        activity.exportText(filename, content)
        return "{\"accepted\":true}"
    }

    @JavascriptInterface
    fun openExternal(url: String): String {
        activity.openExternal(url)
        return "{\"accepted\":true}"
    }
}
