#ifndef DREAMCODE_AUDIO_SUPPORT_H
#define DREAMCODE_AUDIO_SUPPORT_H
#include <CoreAudio/CoreAudio.h>
#include <stdbool.h>
#include <stdint.h>

// A C IOProc keeps allocation, Swift ARC, locks, conversion and pipe IO off the audio thread.
typedef struct DCAudioRing DCAudioRing;
typedef struct DCAudioGate DCAudioGate;
DCAudioGate *dc_gate_create(void);
void dc_gate_close(DCAudioGate *gate);
bool dc_gate_is_open(const DCAudioGate *gate);
void dc_gate_destroy(DCAudioGate *gate);
DCAudioRing *dc_ring_create(uint32_t buffers, uint32_t channels_per_buffer,
                            uint32_t bytes_per_frame, uint32_t max_frames, uint32_t slots);
void dc_ring_destroy(DCAudioRing *ring);
void dc_ring_enable(DCAudioRing *ring, bool enabled);
bool dc_ring_push(DCAudioRing *ring, const AudioBufferList *input);
uint32_t dc_ring_pop(DCAudioRing *ring, AudioBufferList *output, uint32_t capacity_frames);
uint64_t dc_ring_dropped(const DCAudioRing *ring);
// Counters updated atomically on the real-time path, read from a worker queue.
// accepted counts whole packets copied; dropped is a full ring; rejected is a layout/format mismatch.
void dc_ring_stats(const DCAudioRing *ring, uint64_t *io_calls, uint64_t *accepted,
                   uint64_t *dropped, uint64_t *rejected);
OSStatus dc_create_io(AudioObjectID device, DCAudioRing *ring, AudioDeviceIOProcID *io_proc);
// Nonblocking writes no larger than PIPE_BUF: either a whole Float32-aligned chunk or a drop.
int dc_prepare_stdout(void);
int64_t dc_write_pcm(const void *bytes, uint32_t size);

typedef struct {
  int32_t pid;
  int32_t parent_pid;
  uint64_t start_seconds;
  uint64_t start_microseconds;
  char executable[4096];
} DCProcessIdentity;
bool dc_process_identity(int32_t pid, DCProcessIdentity *identity);
#endif
