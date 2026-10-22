import { memo, useEffect, useState, startTransition, type ReactNode } from 'react'
import { HashRouter, useLocation, useNavigate } from 'react-router'
import { toast, Toaster } from 'sonner'
import CoderPage from '@/coder'
import SettingsPage from '@/settings'
import AboutPage from '@/help'
import MemoryCardsPage from '@/memory-cards'
import VoicePage from '@/voice'
import { VoiceCaptureController } from '@/voice/VoiceCaptureController'
import { useSettingsStore } from '@/lib/store/settings'
import { useMemoryCardsStore } from '@/lib/store/memory-cards'
import { currentShortcutMap, hydrateUserProfile } from '@/lib/profile-sync'
import { scrollActivePage, setActivePath } from '@/lib/active-path'

export default function App() {
  const [initialized, setInitialized] = useState(false)
  const settingsStore = useSettingsStore()
  const syncSettings = useSettingsStore((state) => state.syncSettings)

  useEffect(() => {
    let disposed = false
    let receivedNotification = false
    window.api.onAppSettingsChanged((settings) => {
      receivedNotification = true
      syncSettings(settings)
    })
    hydrateUserProfile()
      .then(() => window.api.getAppSettings())
      .then((settings) => {
        if (disposed) return
        if (!receivedNotification) syncSettings(settings)
        window.api.initShortcuts(currentShortcutMap())
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

  useEffect(() => {
    window.api.onScrollPageUp(() => scrollActivePage(-1))
    window.api.onScrollPageDown(() => scrollActivePage(1))
    return () => {
      window.api.removeScrollPageUpListener()
      window.api.removeScrollPageDownListener()
    }
  }, [])

  // Apply dark mode class
  useEffect(() => {
    if (settingsStore.theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [settingsStore.theme])

  return (
    <>
      <HashRouter>
        <ShortcutNavigator />
        <VoiceCaptureController />
        {initialized && <PersistentPages />}
      </HashRouter>

      <Toaster />
    </>
  )
}

const StableSettings = memo(SettingsPage)
const StableAbout = memo(AboutPage)

function PersistentPages() {
  const { pathname } = useLocation()
  const [mounted, setMounted] = useState<Record<string, boolean>>({ '/': true })

  useEffect(() => {
    setMounted((current) => (current[pathname] ? current : { ...current, [pathname]: true }))
  }, [pathname])

  useEffect(() => {
    setActivePath(pathname)
    window.api.updateAppState({
      inCoderPage: pathname === '/' || pathname === '/memory-cards'
    })
  }, [pathname])

  useEffect(() => {
    const warmAll = () => {
      startTransition(() => {
        setMounted((current) => ({
          ...current,
          '/': true,
          '/settings': true,
          '/about': true,
          '/voice': true,
          '/memory-cards': true
        }))
      })
    }
    const idle = window.requestIdleCallback?.(warmAll, { timeout: 800 })
    const timer = window.setTimeout(warmAll, 700)
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle)
      window.clearTimeout(timer)
    }
  }, [])

  return (
    <>
      <PageSlot active={pathname === '/'} mounted={mounted['/'] === true}>
        <CoderPage />
      </PageSlot>
      <PageSlot active={pathname === '/settings'} mounted={mounted['/settings'] === true}>
        <StableSettings />
      </PageSlot>
      <PageSlot active={pathname === '/about'} mounted={mounted['/about'] === true}>
        <StableAbout />
      </PageSlot>
      <PageSlot active={pathname === '/memory-cards'} mounted={mounted['/memory-cards'] === true}>
        <MemoryCardsPage />
      </PageSlot>
      <PageSlot active={pathname === '/voice'} mounted={mounted['/voice'] === true}>
        <VoicePage />
      </PageSlot>
    </>
  )
}

function PageSlot({
  active,
  mounted,
  children
}: {
  active: boolean
  mounted: boolean
  children: ReactNode
}) {
  if (!mounted) return null
  return (
    <div
      className="app-page"
      data-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
    >
      {children}
    </div>
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
