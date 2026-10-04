import { create } from 'zustand'
import type { ScreenshotSnapshot } from '../../../../shared/screenshot'

interface SolutionState {
  screenshotSnapshot: ScreenshotSnapshot | null
  isLoading: boolean
  solutionChunks: string[]
  screenshotData: string | null
  errorMessage: string | null
}

interface SolutionStore extends SolutionState {
  syncScreenshot: (snapshot: ScreenshotSnapshot) => void
  setIsLoading: (isReceiving: boolean) => void
  addSolutionChunk: (chunk: string) => void
  setSolutionChunks: (chunks: string[]) => void
  setScreenshotData: (data: string | null) => void
  setErrorMessage: (message: string | null) => void
  clearSolution: () => void
  resetState: () => void
}

const defaultState: SolutionState = {
  screenshotSnapshot: null,
  isLoading: false,
  solutionChunks: [],
  screenshotData: null,
  errorMessage: null
}

export const useSolutionStore = create<SolutionStore>()((set) => ({
  ...defaultState,
  syncScreenshot: (snapshot) =>
    set((state) => {
      if (state.screenshotSnapshot && snapshot.revision < state.screenshotSnapshot.revision)
        return state
      return {
        screenshotSnapshot: snapshot,
        isLoading: snapshot.busy,
        solutionChunks: snapshot.solution ? [snapshot.solution] : [],
        screenshotData: snapshot.recentScreenshots.at(-1) ?? null,
        errorMessage: snapshot.error
      }
    }),
  setIsLoading: (isReceiving) => {
    set({ isLoading: isReceiving })
  },
  addSolutionChunk: (chunk) => {
    set((state) => ({
      solutionChunks: [...state.solutionChunks, chunk]
    }))
  },
  setSolutionChunks: (chunks) => {
    set({ solutionChunks: chunks })
  },
  setScreenshotData: (data) => {
    set({ screenshotData: data })
  },
  setErrorMessage: (message) => {
    set({ errorMessage: message })
  },
  clearSolution: () => {
    set({ solutionChunks: [], isLoading: false, errorMessage: null })
  },
  resetState: () => {
    set(defaultState)
  }
}))
