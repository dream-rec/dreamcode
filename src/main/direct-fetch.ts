import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici'

/**
 * Undici otherwise follows HTTP_PROXY / HTTPS_PROXY, and Electron's Chromium
 * stack follows the OS proxy. Either one sends Tailscale addresses into a
 * local proxy that cannot reach the tailnet. A bare Agent connects directly.
 */
const directAgent = new Agent()
setGlobalDispatcher(directAgent)

const proxyAgents = new Map<string, ProxyAgent>()

/** Empty proxy URL means a direct connection. A saved URL is the only proxy used. */
export function requestDispatcher(proxyUrl: string | undefined): Agent | ProxyAgent {
  const trimmed = proxyUrl?.trim() ?? ''
  if (!trimmed) return directAgent
  const existing = proxyAgents.get(trimmed)
  if (existing) return existing
  const agent = new ProxyAgent(trimmed)
  proxyAgents.set(trimmed, agent)
  return agent
}

export function createRequestFetch(proxyUrl: string | undefined): typeof globalThis.fetch {
  const dispatcher = requestDispatcher(proxyUrl)
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch
}
