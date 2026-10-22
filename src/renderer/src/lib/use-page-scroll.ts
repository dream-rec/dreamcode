import { useEffect, useRef } from 'react'
import { registerPageContainer } from '@/lib/active-path'

/** Remember this page's scroller. The app scrolls whichever page is visible. */
export function useRegisterPageScroll(path: string) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    registerPageContainer(path, ref.current)
    return () => registerPageContainer(path, null)
  }, [path])
  return ref
}
