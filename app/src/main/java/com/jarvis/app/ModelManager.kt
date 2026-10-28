package com.jarvis.app

import android.content.Context
import android.net.Uri
import android.os.StatFs
import android.provider.OpenableColumns
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

object ModelManager {
    private const val MODEL_FILENAME = "model.gguf"
    private const val PROJECTOR_FILENAME = "mmproj.gguf"
    private const val PREFS = "nova_models"
    private const val GGUF_HEADER_SIZE = 4
    private const val STORAGE_RESERVE = 96L * 1024 * 1024

    data class ImportedModel(val file: File, val displayName: String, val size: Long)

    enum class Kind(val filename: String, val preferenceKey: String) {
        MODEL(MODEL_FILENAME, "model_name"),
        PROJECTOR(PROJECTOR_FILENAME, "projector_name")
    }

    /** Imports to a temporary file and only replaces the active model after full validation. */
    fun copyToInternal(context: Context, uri: Uri, kind: Kind = Kind.MODEL): ImportedModel {
        val metadata = readMetadata(context, uri)
        require(metadata.name.lowercase().endsWith(".gguf")) { "El archivo debe tener extensión .gguf" }
        val filesDirectory = context.filesDir
        val usableSpace = StatFs(filesDirectory.absolutePath).availableBytes - STORAGE_RESERVE
        if (metadata.size > 0 && metadata.size > usableSpace) {
            throw IOException("No hay espacio suficiente. Se requieren ${formatBytes(metadata.size)} más una reserva de seguridad")
        }

        val temp = File(filesDirectory, ".${kind.filename}.${UUID.randomUUID()}.tmp")
        val destination = File(filesDirectory, kind.filename)
        try {
            val rawInput = context.contentResolver.openInputStream(uri)
                ?: throw IOException("Android no permitió leer el archivo")
            rawInput.use { documentInput ->
                DataInputStream(BufferedInputStream(documentInput, 1024 * 1024)).use { input ->
                    val header = ByteArray(GGUF_HEADER_SIZE)
                    input.readFully(header)
                    if (!header.contentEquals(byteArrayOf(0x47, 0x47, 0x55, 0x46))) {
                        throw IOException("La cabecera no corresponde a un modelo GGUF válido")
                    }
                    BufferedOutputStream(FileOutputStream(temp), 1024 * 1024).use { output ->
                        output.write(header)
                        input.copyTo(output, bufferSize = 1024 * 1024)
                        output.flush()
                    }
                }
            }

            if (temp.length() <= GGUF_HEADER_SIZE) throw IOException("El archivo GGUF está vacío o incompleto")
            if (metadata.size > 0 && temp.length() != metadata.size) {
                throw IOException("La copia está incompleta; conserva el archivo original y vuelve a intentarlo")
            }
            Files.move(temp.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(kind.preferenceKey, metadata.name).apply()
            return ImportedModel(destination, metadata.name, destination.length())
        } catch (error: Exception) {
            temp.delete()
            throw error
        }
    }

    fun getSavedModel(context: Context): File? = savedFile(context, Kind.MODEL)
    fun getSavedProjector(context: Context): File? = savedFile(context, Kind.PROJECTOR)

    fun getDisplayName(context: Context, kind: Kind): String? {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(kind.preferenceKey, null)
        return stored ?: savedFile(context, kind)?.name
    }

    private fun savedFile(context: Context, kind: Kind): File? {
        val file = File(context.filesDir, kind.filename)
        return if (file.isFile && file.length() > GGUF_HEADER_SIZE) file else null
    }

    private data class Metadata(val name: String, val size: Long)

    private fun readMetadata(context: Context, uri: Uri): Metadata {
        var name = "model.gguf"
        var size = -1L
        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
        }
        name = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "model.gguf" }
        return Metadata(name, size)
    }

    fun formatBytes(bytes: Long): String = when {
        bytes >= 1024L * 1024 * 1024 -> "%.2f GB".format(bytes / (1024.0 * 1024 * 1024))
        bytes >= 1024L * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024))
        else -> "%.0f KB".format(bytes / 1024.0)
    }
}
