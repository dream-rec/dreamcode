let activePath = '/'
const pathListeners = new Set<(path: string) => void>()

export function getActivePath(): string {
  return activePath
}

export function setActivePath(path: string): void {
  if (path === activePath) return
  activePath = path
  pathListeners.forEach((listener) => listener(path))
}

export function subscribeActivePath(listener: (path: string) => void): () => void {
  pathListeners.add(listener)
  return () => pathListeners.delete(listener)
}

const pageContainers = new Map<string, HTMLElement>()

export function registerPageContainer(path: string, element: HTMLElement | null): void {
  if (element) pageContainers.set(path, element)
  else pageContainers.delete(path)
}

const SCROLL_OFFSET = 120

export function scrollActivePage(direction: -1 | 1): void {
  const container = pageContainers.get(activePath)
  if (!container) return
  container.scrollTo({
    top: container.scrollTop + direction * (window.innerHeight - SCROLL_OFFSET),
    behavior: 'smooth'
  })
}
