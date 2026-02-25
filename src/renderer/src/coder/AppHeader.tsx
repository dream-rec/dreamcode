import { SettingsIcon, HelpCircle, Sun, Moon } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store/app'
import { useSettingsStore } from '@/lib/store/settings'

export function AppHeader() {
  const navigate = useNavigate()
  const { ignoreMouse } = useAppStore()
  const { theme, updateSetting } = useSettingsStore()

  return (
    <div id="app-header" className="flex items-center justify-between px-3">
      {/* macOS traffic light buttons */}
      <div className={`actions flex items-center gap-1.5 ${ignoreMouse ? 'pointer-events-none' : ''}`}>
        <button
          className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-90 transition-all"
          onClick={() => window.close()}
          title="关闭"
        />
        <button
          className="w-3 h-3 rounded-full bg-[#febc2e] hover:brightness-90 transition-all"
          title="最小化"
        />
        <button
          className="w-3 h-3 rounded-full bg-[#28c840] hover:brightness-90 transition-all"
          title="最大化"
        />
      </div>

      {/* Title */}
      <div className="font-medium select-none">DreamCode</div>

      {/* Right actions */}
      <div className={`actions flex items-center ${ignoreMouse ? 'pointer-events-none' : ''}`}>
        <Button
          variant="ghost"
          className="size-7 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
          onClick={() => updateSetting('theme', theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          className="size-7 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
          onClick={() => navigate('/settings')}
        >
          <SettingsIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          className="size-7 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
          onClick={() => navigate('/help')}
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
