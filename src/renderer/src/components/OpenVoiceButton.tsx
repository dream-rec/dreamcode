import type { CSSProperties } from 'react'
import { Mic } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'

const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

export function OpenVoiceButton() {
  const navigate = useNavigate()
  return (
    <Button
      type="button"
      variant="ghost"
      className="size-8 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
      style={noDrag}
      onClick={() => navigate('/voice')}
      title="语音助手"
    >
      <Mic className="h-4 w-4" />
    </Button>
  )
}
