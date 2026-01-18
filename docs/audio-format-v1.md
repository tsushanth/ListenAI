# Audio Format Decision: v1

## Decision: MP3 CBR (Constant Bit Rate)

For v1, we will use **MP3 CBR** as the primary audio output format.

---

## Why MP3 CBR?

### 1. Cross-Platform Compatibility
- Native playback on iOS (AVFoundation)
- Native playback on Android (MediaPlayer)
- Native playback in browsers (HTML5 Audio)
- No codec installation required

### 2. HTTP Range Seeking
- CBR allows accurate byte-to-time mapping
- Enables seeking without downloading entire file
- Formula: `byte_offset = (target_seconds / total_seconds) * file_size`
- Critical for resuming playback from last position

### 3. File Size Reduction
| Format | Size per minute | Compression |
|--------|-----------------|-------------|
| WAV 24kHz 16-bit | 2.88 MB | None |
| MP3 128kbps CBR | 0.96 MB | 3x smaller |
| MP3 64kbps CBR | 0.48 MB | 6x smaller |

### 4. Streaming Friendly
- Can start playback before download completes
- Progressive download works out of the box
- CDN-friendly with proper caching headers

### 5. Simple Implementation
- Well-documented encoding libraries (LAME, FFmpeg)
- No complex manifest files (unlike HLS)
- Single file per article

---

## Recommended Specifications

| Property | Value | Rationale |
|----------|-------|-----------|
| Codec | MP3 (MPEG-1 Layer 3) | Universal support |
| Bit Rate | 64 kbps CBR | Sufficient for speech |
| Sample Rate | 24 kHz | Matches Kokoro output |
| Channels | Mono | Speech doesn't need stereo |
| Quality | Voice-optimized | Focus on clarity |

### Why 64 kbps?

For spoken word content:
- Human speech frequencies: 300 Hz - 3.4 kHz
- 64 kbps captures full speech spectrum
- 128 kbps provides no perceptible quality improvement for speech
- Half the bandwidth/storage of 128 kbps

---

## Implementation Plan

### TTS Service Changes

```python
# tts-service/main.py

# Add MP3 encoding after Kokoro synthesis
import subprocess

def encode_to_mp3(wav_data: bytes, bitrate: int = 64) -> bytes:
    """Convert WAV to MP3 using FFmpeg."""
    process = subprocess.run(
        [
            'ffmpeg', '-i', 'pipe:0',
            '-codec:a', 'libmp3lame',
            '-b:a', f'{bitrate}k',
            '-ar', '24000',
            '-ac', '1',
            '-f', 'mp3',
            'pipe:1'
        ],
        input=wav_data,
        capture_output=True
    )
    return process.stdout
```

### New Endpoint Parameters

```json
{
  "text": "Article text",
  "voice_id": "am_adam",
  "options": {
    "speed": 1.0,
    "format": "mp3",
    "bitrate": 64
  }
}
```

### Response Headers

```
Content-Type: audio/mpeg
Content-Length: 480000
Accept-Ranges: bytes
X-Audio-Duration-Ms: 60000
X-Audio-Bitrate: 64000
```

---

## Streaming Considerations

### Option A: Stream WAV, Cache MP3 (Recommended for v1)

1. Stream WAV chunks for immediate playback (current behavior)
2. After streaming completes, encode combined audio to MP3
3. Cache MP3 for future plays with seeking support

**Pros:**
- Minimal changes to streaming code
- Best of both worlds (fast start + seeking later)

**Cons:**
- First play has no seeking
- Requires encoding step after streaming

### Option B: Stream MP3 Chunks (Future Enhancement)

1. Encode each chunk to MP3 before sending
2. Client concatenates MP3 chunks

**Pros:**
- Smaller transfer size
- MP3 from the start

**Cons:**
- MP3 concatenation is complex (frame alignment)
- May introduce artifacts at chunk boundaries

---

## Migration Path

### Phase 1: Add MP3 Support (v1)
- Add `format=mp3` option to `/api/tts`
- Default remains WAV for backward compatibility
- Streaming continues to use WAV

### Phase 2: Default to MP3 (v1.1)
- Change default format to MP3
- Update iOS client to request MP3
- Convert cached WAV to MP3 on device

### Phase 3: HLS Support (v2, if needed)
- Add HLS manifest generation
- Enable adaptive bitrate
- Only if bandwidth/quality adaptation is required

---

## Alternatives Considered

### AAC
- Better compression than MP3 at same bitrate
- Not universally supported (licensing issues)
- More complex to implement

### Opus
- Best compression for speech
- Limited browser support (older Safari)
- Requires WebM container

### HLS
- Adaptive bitrate streaming
- Complex manifest management
- Overkill for single-quality speech
- Better for v2 if needed

### WAV (Current)
- No compression
- Large files (3x MP3)
- No Range seeking optimization
- Simple but inefficient

---

## File Size Comparison (10-minute article)

| Format | Size | Notes |
|--------|------|-------|
| WAV 24kHz | 28.8 MB | Current |
| MP3 128kbps | 9.6 MB | Overkill for speech |
| MP3 64kbps | 4.8 MB | **Recommended** |
| MP3 32kbps | 2.4 MB | Noticeable quality loss |

---

## Conclusion

**MP3 64kbps CBR** provides the best balance of:
- Universal compatibility
- Efficient seeking via HTTP Range requests
- 6x smaller files than current WAV
- Sufficient quality for speech content
- Simple implementation path

This format will serve as the foundation for v1, with HLS as a potential future upgrade if adaptive streaming becomes necessary.
