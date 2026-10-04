import type { ScreenshotSnapshot } from '../shared/screenshot'
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppSettings } from '../main/settings'
import type { AppState } from '../main/state'
import type { VoiceConfig } from '../shared/settings'
import type {
  AudioApp,
  VoiceCaptureCommand,
  VoiceSegmentPayload,
  VoiceSnapshot
} from '../shared/voice'

// Lock renderer zoom to prevent scaling drift from display changes
webFrame.setZoomFactor(1)
webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)

// Custom APIs for renderer
const api = {
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimizeWindow'),
  maximizeWindow: () => ipcRenderer.invoke('maximizeWindow'),

  // App info & updates
  getAppVersion: () => ipcRenderer.invoke('getAppVersion'),
  checkForUpdate: () => ipcRenderer.invoke('checkForUpdate'),
  openGitHubRelease: () => ipcRenderer.invoke('openGitHubRelease'),
  openGitHubRepo: () => ipcRenderer.invoke('openGitHubRepo'),

  // Get app settings
  getAppSettings: () => ipcRenderer.invoke('getAppSettings'),
  // Update app settings
  updateAppSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('updateAppSettings', settings),
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) => {
    ipcRenderer.on('app-settings-changed', (_event, settings) => {
      callback(settings)
    })
  },
  removeAppSettingsChangedListener: () => {
    ipcRenderer.removeAllListeners('app-settings-changed')
  },
  activateProviderGroup: (id: string) => ipcRenderer.invoke('activateProviderGroup', id),
  activatePromptGroup: (id: string) => ipcRenderer.invoke('activatePromptGroup', id),
  onGroupSwitched: (callback: (message: string) => void) => {
    ipcRenderer.on('group-switched', (_event, message) => {
      callback(message)
    })
  },
  removeGroupSwitchedListener: () => {
    ipcRenderer.removeAllListeners('group-switched')
  },

  // Update app state
  updateAppState: (state: Partial<AppState>) => ipcRenderer.invoke('updateAppState', state),
  // Listen for app state
  onSyncAppState: (callback: (state: AppState) => void) => {
    ipcRenderer.on('sync-app-state', (_event, state) => {
      callback(state)
    })
  },
  // Remove app state listener
  removeSyncAppStateListener: () => {
    ipcRenderer.removeAllListeners('sync-app-state')
  },

  // Init shortcuts
  initShortcuts: (shortcuts: Record<string, { action: string; key: string }>) =>
    ipcRenderer.invoke('initShortcuts', shortcuts),
  // Get shortcuts
  getShortcuts: () => ipcRenderer.invoke('getShortcuts'),
  // Update shortcuts
  updateShortcuts: (shortcuts: { action: string; key: string }[]) =>
    ipcRenderer.invoke('updateShortcuts', shortcuts),

  // Listen for screenshot events
  onScreenshotTaken: (callback: (screenshotData: string) => void) => {
    ipcRenderer.on('screenshot-taken', (_event, screenshotData) => {
      callback(screenshotData)
    })
  },
  // Remove screenshot listener
  removeScreenshotListener: () => {
    ipcRenderer.removeAllListeners('screenshot-taken')
  },

  // Listen for solution chunks
  onSolutionChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('solution-chunk', (_event, chunk) => {
      callback(chunk)
    })
  },
  // Remove solution chunk listener
  removeSolutionChunkListener: () => {
    ipcRenderer.removeAllListeners('solution-chunk')
  },

  // Stop solution stream
  stopSolutionStream: () => ipcRenderer.invoke('stopSolutionStream'),

  // Send follow-up question
  sendFollowUpQuestion: (question: string) => ipcRenderer.invoke('sendFollowUpQuestion', question),

  // Listen for solution completion
  onSolutionComplete: (callback: () => void) => {
    ipcRenderer.on('solution-complete', callback)
  },
  removeSolutionCompleteListener: () => {
    ipcRenderer.removeAllListeners('solution-complete')
  },

  onSolutionStopped: (callback: () => void) => {
    ipcRenderer.on('solution-stopped', callback)
  },
  removeSolutionStoppedListener: () => {
    ipcRenderer.removeAllListeners('solution-stopped')
  },

  onSolutionError: (callback: (message: string) => void) => {
    ipcRenderer.on('solution-error', (_event, message) => {
      callback(message)
    })
  },
  removeSolutionErrorListener: () => {
    ipcRenderer.removeAllListeners('solution-error')
  },

  // Listen for scroll page up
  onScrollPageUp: (callback: () => void) => {
    ipcRenderer.on('scroll-page-up', callback)
  },
  // Remove scroll page up listener
  removeScrollPageUpListener: () => {
    ipcRenderer.removeAllListeners('scroll-page-up')
  },

  // Listen for screenshots-updated (gallery)
  onScreenshotsUpdated: (callback: (screenshots: string[]) => void) => {
    ipcRenderer.on('screenshots-updated', (_event, screenshots) => {
      callback(screenshots)
    })
  },
  removeScreenshotsUpdatedListener: () => {
    ipcRenderer.removeAllListeners('screenshots-updated')
  },

  // Listen for scroll page down
  onScrollPageDown: (callback: () => void) => {
    ipcRenderer.on('scroll-page-down', callback)
  },
  // Remove scroll page down listener
  removeScrollPageDownListener: () => {
    ipcRenderer.removeAllListeners('scroll-page-down')
  },

  // Navigate to memory card by index
  onNavigateMemoryCard: (callback: (index: number) => void) => {
    ipcRenderer.on('navigate-memory-card', (_event, index) => {
      callback(index)
    })
  },
  removeNavigateMemoryCardListener: () => {
    ipcRenderer.removeAllListeners('navigate-memory-card')
  },

  // Navigate back to coder page
  onNavigateCoderPage: (callback: () => void) => {
    ipcRenderer.on('navigate-coder-page', callback)
  },
  removeNavigateCoderPageListener: () => {
    ipcRenderer.removeAllListeners('navigate-coder-page')
  },

  // AI loading events
  onAiLoadingStart: (callback: () => void) => {
    ipcRenderer.on('ai-loading-start', callback)
  },
  onAiLoadingEnd: (callback: () => void) => {
    ipcRenderer.on('ai-loading-end', callback)
  },
  removeAiLoadingStartListener: () => {
    ipcRenderer.removeAllListeners('ai-loading-start')
  },
  removeAiLoadingEndListener: () => {
    ipcRenderer.removeAllListeners('ai-loading-end')
  },

  // Solution clear event (new session)
  onSolutionClear: (callback: () => void) => {
    ipcRenderer.on('solution-clear', callback)
  },
  removeSolutionClearListener: () => {
    ipcRenderer.removeAllListeners('solution-clear')
  },

  getScreenshotState: (): Promise<ScreenshotSnapshot> => ipcRenderer.invoke('screenshot:getState'),
  onScreenshotState: (callback: (snapshot: ScreenshotSnapshot) => void) => {
    const listener = (_event: unknown, snapshot: ScreenshotSnapshot): void => callback(snapshot)
    ipcRenderer.on('screenshot-state', listener)
    return () => ipcRenderer.removeListener('screenshot-state', listener)
  },

  // ---- Voice assistant ----
  voiceGetSnapshot: (): Promise<VoiceSnapshot> => ipcRenderer.invoke('voice:getSnapshot'),
  voiceToggleListening: () => ipcRenderer.invoke('voice:toggleListening'),
  voiceSendNow: () => ipcRenderer.invoke('voice:sendNow'),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
  voiceClearSession: () => ipcRenderer.invoke('voice:clearSession'),
  voiceStopAnswer: () => ipcRenderer.invoke('voice:stopAnswer'),
  voiceDismissError: () => ipcRenderer.invoke('voice:dismissError'),
  voiceSelectSegment: (seq: number, extend: boolean) =>
    ipcRenderer.invoke('voice:selectSegment', seq, extend),
  voiceMoveSelection: (delta: -1 | 1) => ipcRenderer.invoke('voice:moveSelection', delta),
  voiceClearSelection: () => ipcRenderer.invoke('voice:clearSelection'),
  voiceSendSelected: () => ipcRenderer.invoke('voice:sendSelected'),
  // Per-application audio (native helper in main, PCM streamed back)
  voiceListAudioApps: (): Promise<AudioApp[]> => ipcRenderer.invoke('voice:listAudioApps'),
  /** macOS 音频录制授权检查：未授权时主进程会弹窗引导，返回 false 表示不应开始采集。 */
  voiceEnsureCapturePermission: (): Promise<boolean> =>
    ipcRenderer.invoke('voice:ensureCapturePermission'),
  /** Starts the helper; `onVoiceAppAudio` receives the session's PCM and end events. */
  voiceReserveCapture: (id: string, owner: 'voice' | 'test'): Promise<void> =>
    ipcRenderer.invoke('voice:reserveCapture', id, owner),
  voiceReleaseCapture: (id: string): Promise<void> =>
    ipcRenderer.invoke('voice:releaseCapture', id),
  voiceAppCaptureStart: (appId: string, id: string): Promise<void> =>
    ipcRenderer.invoke('voice:appCaptureStart', appId, id),
  voiceAppCaptureStop: (id: string): Promise<void> =>
    ipcRenderer.invoke('voice:appCaptureStop', id),
  /** Subscribes to one capture's PCM / end events; returns an unsubscribe function. */
  onVoiceAppAudio: (
    id: string,
    onPcm: (samples: Float32Array) => void,
    onEnded: (reason: string) => void
  ) => {
    const pcmListener = (_event: unknown, payload: { id: string; samples: Float32Array }) => {
      if (payload.id === id) onPcm(payload.samples)
    }
    const endedListener = (_event: unknown, payload: { id: string; reason: string }) => {
      if (payload.id === id) onEnded(payload.reason)
    }
    ipcRenderer.on('voice-app-pcm', pcmListener)
    ipcRenderer.on('voice-app-ended', endedListener)
    return () => {
      ipcRenderer.removeListener('voice-app-pcm', pcmListener)
      ipcRenderer.removeListener('voice-app-ended', endedListener)
    }
  },
  // Capture controller → main acknowledgements
  voiceCaptureStarted: (id: string) => ipcRenderer.invoke('voice:captureStarted', id),
  voiceCaptureStopped: (id: string, requestId: string) =>
    ipcRenderer.invoke('voice:captureStopped', id, requestId),
  voiceFlushed: (id: string, requestId: string) =>
    ipcRenderer.invoke('voice:flushed', id, requestId),
  voiceCaptureError: (id: string, message: string) =>
    ipcRenderer.invoke('voice:captureError', id, message),
  voicePushSegment: (payload: VoiceSegmentPayload) =>
    ipcRenderer.invoke('voice:pushSegment', payload),
  voiceTestTranscribe: (config: VoiceConfig, wav: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('voice:testTranscribe', config, wav),
  onVoiceCaptureCommand: (callback: (command: VoiceCaptureCommand) => void) => {
    ipcRenderer.on('voice-capture-command', (_event, command) => {
      callback(command)
    })
  },
  removeVoiceCaptureCommandListener: () => {
    ipcRenderer.removeAllListeners('voice-capture-command')
  },
  onVoiceState: (callback: (snapshot: VoiceSnapshot) => void) => {
    ipcRenderer.on('voice-state', (_event, snapshot) => {
      callback(snapshot)
    })
  },
  removeVoiceStateListener: () => {
    ipcRenderer.removeAllListeners('voice-state')
  },
  onVoiceAnswerChunk: (callback: (payload: { id: string; chunk: string }) => void) => {
    ipcRenderer.on('voice-answer-chunk', (_event, payload) => {
      callback(payload)
    })
  },
  removeVoiceAnswerChunkListener: () => {
    ipcRenderer.removeAllListeners('voice-answer-chunk')
  },
  onNavigateVoicePage: (callback: () => void) => {
    ipcRenderer.on('navigate-voice-page', callback)
  },
  removeNavigateVoicePageListener: () => {
    ipcRenderer.removeAllListeners('navigate-voice-page')
  }
}

export type MainAPI = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
