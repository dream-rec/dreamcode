const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent

export const isMac = userAgent.includes('Mac')
export const isWindows = userAgent.includes('Windows')
