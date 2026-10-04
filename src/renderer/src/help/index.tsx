import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, Info, RefreshCw, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpSection } from './components'
import { Shortcuts } from './Shortcuts'
import { useSettingsStore } from '@/lib/store/settings'

export default function HelpPage() {
  const [checking, setChecking] = useState(false)
  const [hasUpdate, setHasUpdate] = useState(false)
  const [updateResult, setUpdateResult] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string>('')
  const { autoCheckUpdate, saveSettings } = useSettingsStore()

  useEffect(() => {
    window.api.getAppVersion().then((v: string) => setAppVersion(v))
  }, [])

  const handleCheckUpdate = async () => {
    setChecking(true)
    setUpdateResult(null)
    setHasUpdate(false)
    try {
      const result = await window.api.checkForUpdate()
      if (result.hasUpdate) {
        setHasUpdate(true)
        setUpdateResult(`发现新版本 v${result.latestVersion}`)
      } else {
        setHasUpdate(false)
        setUpdateResult('当前已是最新版本')
      }
    } catch {
      setHasUpdate(false)
      setUpdateResult('检查更新失败，请稍后重试')
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      {/* Header */}
      <div id="app-header" className="flex items-center px-3">
        <div className="actions">
          <Button variant="ghost" size="icon" asChild className="size-7 hover:bg-black/10 dark:hover:bg-white/10 rounded-md">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <h1 className="flex-1 text-center font-medium select-none pr-7">关于</h1>
      </div>

      {/* Content */}
      <div id="app-content" className="flex flex-col gap-4 p-8">
        {/* About */}
        <HelpSection Icon={Info} title="关于 DreamCode">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">版本</span>
              <span className="text-sm font-mono text-gray-800 dark:text-gray-200">v{appVersion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">开源协议</span>
              <span className="text-sm text-gray-800 dark:text-gray-200">CC BY-NC 4.0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">项目地址</span>
              <button
                onClick={() => window.api.openGitHubRepo()}
                className="text-sm text-blue-600 hover:underline flex items-center gap-1"
              >
                github.com/dream-rec/dreamcode
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCheckUpdate}
                    disabled={checking}
                    className="h-8"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${checking ? 'animate-spin' : ''}`} />
                    {checking ? '检查中...' : '检查更新'}
                  </Button>
                  {updateResult && (
                    <span className="text-xs text-gray-600 dark:text-gray-400">{updateResult}</span>
                  )}
                </div>
                {hasUpdate && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => window.api.openGitHubRelease()}
                    className="h-8"
                  >
                    前往下载
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="auto-check-update"
                  checked={autoCheckUpdate}
                  onCheckedChange={(checked) => {
                    void saveSettings({ autoCheckUpdate: checked === true }).catch(
                      (error: unknown) => {
                        setUpdateResult(error instanceof Error ? error.message : '设置保存失败')
                      }
                    )
                  }}
                />
                <label htmlFor="auto-check-update" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  启动时自动检查更新
                </label>
              </div>
            </div>
          </div>
        </HelpSection>

        {/* Keyboard Shortcuts */}
        <Shortcuts />
      </div>
    </>
  )
}
