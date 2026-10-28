package com.jarvis.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerSettingsTest {
    @Test
    fun sanitizesResourcesAndDeduplicatesRpcNodes() {
        val settings = ServerSettings(
            context = 9999,
            threads = 99,
            batch = 4,
            rpcEnabled = true,
            rpcEndpoints = listOf("192.168.1.20:50052", "192.168.1.20:50052", "http://bad:1")
        ).sanitized()
        assertEquals(8192, settings.context)
        assertEquals(16, settings.threads)
        assertEquals(32, settings.batch)
        assertEquals(listOf("192.168.1.20:50052"), settings.rpcEndpoints)
        assertTrue(settings.rpcEnabled)
    }

    @Test
    fun disablesRpcWhenNoValidWorkerRemains() {
        val settings = ServerSettings(rpcEnabled = true, rpcEndpoints = listOf("https://unsafe:50052")).sanitized()
        assertFalse(settings.rpcEnabled)
        assertTrue(settings.rpcEndpoints.isEmpty())
    }
}
