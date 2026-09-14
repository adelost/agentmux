package io.agentmux.audioinbox

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

private const val CODEC_TIMEOUT_US = 10_000L

/**
 * WHAT: Encodes mono PCM to AAC-LC in an MPEG-4 file.
 * WHY: A wake-word question uploads in the same container and codec as a push-to-talk recording,
 * so the server path stays unchanged.
 */
internal object PcmAacEncoder {
    fun encode(samples: ShortArray, sampleRate: Int, output: File) {
        val bytes = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            .also { it.asShortBuffer().put(samples) }.array()
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 48_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxing = false
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            var offset = 0
            var inputDone = false
            var track = -1
            val info = MediaCodec.BufferInfo()
            while (true) {
                if (!inputDone) {
                    val index = codec.dequeueInputBuffer(CODEC_TIMEOUT_US)
                    if (index >= 0) {
                        val buffer = requireNotNull(codec.getInputBuffer(index))
                        buffer.clear()
                        val count = minOf(buffer.remaining(), bytes.size - offset).let { it - it % 2 }
                        val presentationUs = offset / 2 * 1_000_000L / sampleRate
                        if (count == 0) {
                            codec.queueInputBuffer(index, 0, 0, presentationUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            buffer.put(bytes, offset, count)
                            codec.queueInputBuffer(index, 0, count, presentationUs, 0)
                            offset += count
                        }
                    }
                }
                val out = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    muxing = true
                } else if (out >= 0) {
                    val data = requireNotNull(codec.getOutputBuffer(out))
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (!config && info.size > 0) {
                        check(muxing) { "AAC encoder produced audio before its format" }
                        data.position(info.offset)
                        data.limit(info.offset + info.size)
                        muxer.writeSampleData(track, data, info)
                    }
                    codec.releaseOutputBuffer(out, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            if (muxing) muxer.stop()
            muxer.release()
        }
    }
}
