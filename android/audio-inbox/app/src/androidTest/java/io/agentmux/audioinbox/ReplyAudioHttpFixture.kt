package io.agentmux.audioinbox

import java.net.ServerSocket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Real local HTTP + decodable silence; no agent request or paid speech call. */
internal class ReplyAudioHttpFixture(private val expectedRequests: Int = 3) : AutoCloseable {
    private val server = ServerSocket(0)
    val url = "http://127.0.0.1:${server.localPort}"
    val thirdRequested = CountDownLatch(1)
    val finishThird = CountDownLatch(1)
    val requests = java.util.concurrent.atomic.AtomicInteger()
    private val worker = thread(name = "link-audio-http-proof") {
        try {
        repeat(expectedRequests) { index ->
            server.accept().use { socket ->
                requests.incrementAndGet()
                socket.soTimeout = 8000
                val input = socket.getInputStream().bufferedReader()
                var size = 0
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Content-Length:", true)) size = line.substringAfter(':').trim().toInt()
                }
                repeat(size) { input.read() }
                if (index == 2) {
                    thirdRequested.countDown()
                    check(finishThird.await(8, TimeUnit.SECONDS))
                }
                val pcmBytes = 8000 * 2 * 20
                val wav = ByteBuffer.allocate(44 + pcmBytes).order(ByteOrder.LITTLE_ENDIAN).apply {
                    put("RIFF".toByteArray()); putInt(36 + pcmBytes); put("WAVEfmt ".toByteArray())
                    putInt(16); putShort(1); putShort(1); putInt(8000); putInt(16000)
                    putShort(2); putShort(16); put("data".toByteArray()); putInt(pcmBytes)
                }.array()
                socket.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: ${wav.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(wav); flush()
                }
            }
        }
        } catch (error: java.net.SocketException) {
            if (!server.isClosed) throw error
        }
    }
    override fun close() {
        finishThird.countDown()
        server.close()
        worker.join(1000)
    }
}
