import { cn } from '@/lib/utils'
import { getActivePath } from '@/lib/active-path'
import { useVoiceStore } from '@/lib/store/voice'

const FLOOR_DB = -80

function toPercent(db: number): number {
  return Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100))
}

/** Horizontal input-level bar with a marker at the VAD threshold. */
export function LevelMeter({
  level,
  thresholdDb,
  active,
  className
}: {
  /** Omit to follow the live voice meter without re-rendering the rest of the page. */
  level?: number
  thresholdDb: number
  active: boolean
  className?: string
}) {
  if (typeof level === 'number') {
    return (
      <LevelMeterBar
        level={level}
        thresholdDb={thresholdDb}
        active={active}
        className={className}
      />
    )
  }
  return <StoreLevelMeter thresholdDb={thresholdDb} active={active} className={className} />
}

function StoreLevelMeter({
  thresholdDb,
  active,
  className
}: {
  thresholdDb: number
  active: boolean
  className?: string
}) {
  const level = useVoiceStore((state) => (getActivePath() === '/voice' ? state.level : -100))
  return (
    <LevelMeterBar level={level} thresholdDb={thresholdDb} active={active} className={className} />
  )
}

function LevelMeterBar({
  level,
  thresholdDb,
  active,
  className
}: {
  level: number
  thresholdDb: number
  active: boolean
  className?: string
}) {
  const percent = active ? toPercent(level) : 0
  const loud = active && level >= thresholdDb
  return (
    <div
      className={cn(
        'relative h-2 w-full rounded-full bg-gray-300/60 dark:bg-gray-600/60 overflow-hidden',
        className
      )}
      title={active ? `${level.toFixed(0)} dBFS（阈值 ${thresholdDb} dBFS）` : '未监听'}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-75',
          loud ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-500'
        )}
        style={{ width: `${percent}%` }}
      />
      <div
        className="absolute top-0 h-full w-0.5 bg-red-500/80"
        style={{ left: `${toPercent(thresholdDb)}%` }}
      />
    </div>
  )
}
