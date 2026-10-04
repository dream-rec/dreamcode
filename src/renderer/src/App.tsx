import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router'
import { toast, Toaster } from 'sonner'
import CoderPage from '@/coder'
import SettingsPage from '@/settings'
import AboutPage from '@/help'
import MemoryCardsPage from '@/memory-cards'
import VoicePage from '@/voice'
import { VoiceCaptureController } from '@/voice/VoiceCaptureController'
import { useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useMemoryCardsStore } from '@/lib/store/memory-cards'

export default function App() {
  const [initialized, setInitialized] = useState(false)
  const settingsStore = useSettingsStore()
  const syncSettings = useSettingsStore((state) => state.syncSettings)
  const { shortcuts } = useShortcutsStore()

  useEffect(() => {
    let disposed = false
    let receivedNotification = false
    window.api.onAppSettingsChanged((settings) => {
      receivedNotification = true
      syncSettings(settings)
    })
    window.api
      .getAppSettings()
      .then((settings) => {
        if (disposed) return
        if (!receivedNotification) syncSettings(settings)
        setInitialized(true)
      })
      .catch((error: unknown) => {
        if (disposed) return
        console.error('settings_load_failed', error)
        toast.error('设置加载失败，请重新打开应用')
      })
    return () => {
      disposed = true
      window.api.removeAppSettingsChangedListener()
    }
  }, [syncSettings])

  useEffect(() => {
    window.api.onGroupSwitched((message) => {
      toast.success(message)
    })
    return () => {
      window.api.removeGroupSwitchedListener()
    }
  }, [])

  // Apply opacity globally across all routes
  useEffect(() => {
    document.body.style.opacity = settingsStore.opacity.toString()
  }, [settingsStore.opacity])

  // Apply dark mode class
  useEffect(() => {
    if (settingsStore.theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [settingsStore.theme])

  useEffect(() => {
    window.api.initShortcuts(shortcuts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <HashRouter>
        <ShortcutNavigator />
        <VoiceCaptureController />
        {initialized && (
          <Routes>
            <Route index element={<CoderPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="memory-cards" element={<MemoryCardsPage />} />
            <Route path="voice" element={<VoicePage />} />
          </Routes>
        )}
      </HashRouter>

      <Toaster />
    </>
  )
}

function ShortcutNavigator() {
  const navigate = useNavigate()
  const { cards, selectCard } = useMemoryCardsStore()

  useEffect(() => {
    window.api.onNavigateMemoryCard((index: number) => {
      if (index < cards.length) {
        selectCard(cards[index].id)
        navigate('/memory-cards', { state: { cardId: cards[index].id } })
      }
    })
    return () => {
      window.api.removeNavigateMemoryCardListener()
    }
  }, [navigate, cards, selectCard])

  useEffect(() => {
    window.api.onNavigateCoderPage(() => {
      navigate('/')
    })
    return () => {
      window.api.removeNavigateCoderPageListener()
    }
  }, [navigate])

  useEffect(() => {
    window.api.onNavigateVoicePage(() => {
      navigate('/voice')
    })
    return () => {
      window.api.removeNavigateVoicePageListener()
    }
  }, [navigate])

  return null
}
