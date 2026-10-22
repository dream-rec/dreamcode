import { memo, useEffect } from 'react'
import { useAppStore } from '@/lib/store/app'

import { AppHeader } from './AppHeader'
import { AppContent } from './AppContent'
import { AppStatusBar } from './AppStatusBar'
import { PrerequisitesChecker } from './PrerequisitesChecker'

function CoderPage() {
  const { syncAppState } = useAppStore()

  useEffect(() => {
    window.api.onSyncAppState((state) => {
      syncAppState(state)
    })
    return () => {
      window.api.removeSyncAppStateListener()
    }
  }, [syncAppState])

  return (
    <>
      <AppHeader />
      <AppContent />
      <AppStatusBar />
      <PrerequisitesChecker />
    </>
  )
}

export default memo(CoderPage)
