#include "audio-support.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <unistd.h>

struct DCAudioGate { atomic_bool open; };
DCAudioGate *dc_gate_create(void) {
  DCAudioGate *gate = calloc(1, sizeof(*gate));
  if (gate) atomic_init(&gate->open, true);
  return gate;
}
void dc_gate_close(DCAudioGate *gate) { atomic_store_explicit(&gate->open, false, memory_order_release); }
bool dc_gate_is_open(const DCAudioGate *gate) { return atomic_load_explicit(&gate->open, memory_order_acquire); }
void dc_gate_destroy(DCAudioGate *gate) { free(gate); }

struct DCAudioRing {
  uint32_t buffers, channels, bytes_per_frame, max_frames, slots;
  uint8_t *storage;
  uint32_t *frames;
  atomic_uint_fast64_t read_index, write_index, dropped, rejected, io_calls;
  atomic_bool enabled;
};
DCAudioRing *dc_ring_create(uint32_t buffers, uint32_t channels, uint32_t bytes_per_frame,
                            uint32_t max_frames, uint32_t slots) {
  if (!buffers || buffers > 2 || !channels || channels > 2 || !bytes_per_frame ||
      bytes_per_frame > 16 || !max_frames || max_frames > 16384 || slots < 2 || slots > 64) return NULL;
  DCAudioRing *ring = calloc(1, sizeof(*ring));
  if (!ring) return NULL;
  ring->buffers = buffers; ring->channels = channels; ring->bytes_per_frame = bytes_per_frame;
  ring->max_frames = max_frames; ring->slots = slots;
  ring->storage = calloc(slots, (size_t)buffers * bytes_per_frame * max_frames);
  ring->frames = calloc(slots, sizeof(uint32_t));
  atomic_init(&ring->read_index, 0); atomic_init(&ring->write_index, 0);
  atomic_init(&ring->dropped, 0); atomic_init(&ring->rejected, 0); atomic_init(&ring->io_calls, 0);
  atomic_init(&ring->enabled, false);
  if (!ring->storage || !ring->frames || !atomic_is_lock_free(&ring->read_index) ||
      !atomic_is_lock_free(&ring->write_index) || !atomic_is_lock_free(&ring->dropped) ||
      !atomic_is_lock_free(&ring->rejected) || !atomic_is_lock_free(&ring->io_calls) ||
      !atomic_is_lock_free(&ring->enabled)) {
    dc_ring_destroy(ring); return NULL;
  }
  return ring;
}
void dc_ring_destroy(DCAudioRing *ring) {
  if (!ring) return;
  free(ring->storage); free(ring->frames); free(ring);
}
void dc_ring_enable(DCAudioRing *ring, bool enabled) {
  atomic_store_explicit(&ring->enabled, enabled, memory_order_release);
}
bool dc_ring_push(DCAudioRing *ring, const AudioBufferList *input) {
  if (!atomic_load_explicit(&ring->enabled, memory_order_acquire)) return false;
  uint64_t write_index = atomic_load_explicit(&ring->write_index, memory_order_relaxed);
  uint64_t read_index = atomic_load_explicit(&ring->read_index, memory_order_acquire);
  if (write_index - read_index >= ring->slots) goto full;
  if (!input || input->mNumberBuffers != ring->buffers) goto rejected;
  uint32_t frames = input->mBuffers[0].mDataByteSize / ring->bytes_per_frame;
  if (!frames || frames > ring->max_frames) goto rejected;
  for (uint32_t b = 0; b < ring->buffers; b++) {
    const AudioBuffer *buffer = &input->mBuffers[b];
    if (!buffer->mData || buffer->mNumberChannels != ring->channels ||
        buffer->mDataByteSize != frames * ring->bytes_per_frame) goto rejected;
  }
  size_t slot = write_index % ring->slots;
  for (uint32_t b = 0; b < ring->buffers; b++) {
    size_t offset = (slot * ring->buffers + b) * ring->max_frames * ring->bytes_per_frame;
    memcpy(ring->storage + offset, input->mBuffers[b].mData, frames * ring->bytes_per_frame);
  }
  ring->frames[slot] = frames;
  atomic_store_explicit(&ring->write_index, write_index + 1, memory_order_release);
  return true;
full:
  atomic_fetch_add_explicit(&ring->dropped, 1, memory_order_relaxed);
  return false;
rejected:
  // Layout/format mismatch is a different failure than a full ring: diagnostics must not conflate them.
  atomic_fetch_add_explicit(&ring->rejected, 1, memory_order_relaxed);
  return false;
}
uint32_t dc_ring_pop(DCAudioRing *ring, AudioBufferList *output, uint32_t capacity_frames) {
  uint64_t read_index = atomic_load_explicit(&ring->read_index, memory_order_relaxed);
  if (read_index == atomic_load_explicit(&ring->write_index, memory_order_acquire)) return 0;
  size_t slot = read_index % ring->slots;
  uint32_t frames = ring->frames[slot];
  if (!output || output->mNumberBuffers != ring->buffers || frames > capacity_frames) return 0;
  for (uint32_t b = 0; b < ring->buffers; b++) {
    if (!output->mBuffers[b].mData) return 0;
    size_t offset = (slot * ring->buffers + b) * ring->max_frames * ring->bytes_per_frame;
    memcpy(output->mBuffers[b].mData, ring->storage + offset, frames * ring->bytes_per_frame);
    output->mBuffers[b].mDataByteSize = frames * ring->bytes_per_frame;
  }
  atomic_store_explicit(&ring->read_index, read_index + 1, memory_order_release);
  return frames;
}
uint64_t dc_ring_dropped(const DCAudioRing *ring) {
  return atomic_load_explicit(&ring->dropped, memory_order_relaxed);
}
void dc_ring_stats(const DCAudioRing *ring, uint64_t *io_calls, uint64_t *accepted,
                   uint64_t *dropped, uint64_t *rejected) {
  if (io_calls) *io_calls = atomic_load_explicit(&ring->io_calls, memory_order_relaxed);
  if (accepted) *accepted = atomic_load_explicit(&ring->write_index, memory_order_relaxed);
  if (dropped) *dropped = atomic_load_explicit(&ring->dropped, memory_order_relaxed);
  if (rejected) *rejected = atomic_load_explicit(&ring->rejected, memory_order_relaxed);
}
OSStatus dc_audio_io(AudioObjectID device, const AudioTimeStamp *now,
                     const AudioBufferList *input, const AudioTimeStamp *input_time,
                     AudioBufferList *output, const AudioTimeStamp *output_time, void *context) {
  (void)device; (void)now; (void)input_time; (void)output; (void)output_time;
  // Real-time thread: atomics only, no logging; the report happens on a worker queue.
  atomic_fetch_add_explicit(&((DCAudioRing *)context)->io_calls, 1, memory_order_relaxed);
  dc_ring_push(context, input);
  return noErr;
}
OSStatus dc_create_io(AudioObjectID device, DCAudioRing *ring, AudioDeviceIOProcID *io_proc) {
  return AudioDeviceCreateIOProcID(device, dc_audio_io, ring, io_proc);
}
int dc_prepare_stdout(void) {
  int flags = fcntl(STDOUT_FILENO, F_GETFL);
  return flags < 0 ? -1 : fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK);
}
int64_t dc_write_pcm(const void *bytes, uint32_t size) {
  if (size % sizeof(float)) return -1;
  uint32_t offset = 0, dropped = 0;
  while (offset < size) {
    uint32_t count = size - offset;
    if (count > PIPE_BUF) count = PIPE_BUF - PIPE_BUF % sizeof(float);
    ssize_t result = write(STDOUT_FILENO, (const uint8_t *)bytes + offset, count);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) dropped += count;
    else if (result != count) return -1; // Never continue a misaligned/partial output stream.
    offset += count;
  }
  return dropped / sizeof(float);
}
bool dc_process_identity(int32_t pid, DCProcessIdentity *identity) {
  struct proc_bsdinfo before = {0}, after = {0};
  if (pid <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) return false;
  memset(identity, 0, sizeof(*identity));
  if (proc_pidpath(pid, identity->executable, sizeof(identity->executable)) <= 0 ||
      proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) return false;
  if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec ||
      before.pbi_ppid != after.pbi_ppid || before.pbi_status == SZOMB || after.pbi_status == SZOMB) return false;
  identity->pid = pid; identity->parent_pid = (int32_t)after.pbi_ppid;
  identity->start_seconds = after.pbi_start_tvsec; identity->start_microseconds = after.pbi_start_tvusec;
  return true;
}
