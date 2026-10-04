import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ArrowLeft, Keyboard, Palette, Save, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useSettingsStore } from '@/lib/store/settings'
import { CustomShortcuts, ResetDefaultShortcuts } from './CustomShortcuts'
import { GroupSettings } from './GroupSettings'
import { VoiceSettings } from './VoiceSettings'

export default function SettingsPage() {
  const settingsStore = useSettingsStore()
  const navigate = useNavigate()
  const [providerGroups, setProviderGroups] = useState(settingsStore.providerGroups)
  const [promptGroups, setPromptGroups] = useState(settingsStore.promptGroups)
  const [activeProviderGroupId, setActiveProviderGroupId] = useState(
    settingsStore.activeProviderGroupId
  )
  const [activePromptGroupId, setActivePromptGroupId] = useState(settingsStore.activePromptGroupId)
  const [opacity, setOpacity] = useState(settingsStore.opacity)
  const [fontSize, setFontSize] = useState(settingsStore.fontSize)
  const [voice, setVoice] = useState(settingsStore.voice)

  const [isSaving, setIsSaving] = useState(false)
  const saving = useRef(false)

  // Drafts belong to this visit, not to each incoming main-process notification.
  // App waits for initial settings before mounting routes.

  useEffect(() => {
    document.body.style.opacity = opacity.toString()
  }, [opacity])

  useEffect(() => {
    return () => {
      document.body.style.opacity = useSettingsStore.getState().opacity.toString()
    }
  }, [])

  const commitSettings = async (): Promise<void> => {
    const activeProvider =
      providerGroups.find((group) => group.id === activeProviderGroupId) ?? providerGroups[0]
    const activePrompt =
      promptGroups.find((group) => group.id === activePromptGroupId) ?? promptGroups[0]
    if (!activeProvider || !activePrompt) return

    const newSettings = {
      apiProvider: activeProvider.apiProvider,
      apiBaseURL: activeProvider.apiBaseURL,
      apiKey: activeProvider.apiKey,
      extraHeaders: activeProvider.extraHeaders,
      model: activeProvider.model,
      proxyUrl: activeProvider.proxyUrl,
      codeLanguage: activePrompt.codeLanguage,
      customPrompt: activePrompt.customPrompt,
      providerGroups,
      promptGroups,
      activeProviderGroupId: activeProvider.id,
      activePromptGroupId: activePrompt.id,
      voice
    }
    await settingsStore.saveSettings(newSettings)
    settingsStore.updateSetting('opacity', opacity)
    settingsStore.updateSetting('fontSize', fontSize)
  }

  const handleSave = async (): Promise<void> => {
    if (saving.current) return
    saving.current = true
    setIsSaving(true)
    try {
      await commitSettings()
      toast.success('设置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '设置保存失败，请重试')
    } finally {
      saving.current = false
      setIsSaving(false)
    }
  }

  return (
    <>
      <div id="app-header" className="flex items-center px-3">
        <div className="actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        <h1 className="flex-1 text-center font-medium select-none">设置</h1>
        <div className="actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
            onClick={handleSave}
            disabled={isSaving}
            title="保存设置"
          >
            <Save className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div id="app-content" className="flex flex-col gap-4 p-8">
        <GroupSettings
          providerGroups={providerGroups}
          promptGroups={promptGroups}
          activeProviderGroupId={activeProviderGroupId}
          activePromptGroupId={activePromptGroupId}
          onProviderGroupsChange={setProviderGroups}
          onPromptGroupsChange={setPromptGroups}
          onProviderGroupSelect={setActiveProviderGroupId}
          onPromptGroupSelect={setActivePromptGroupId}
        />

        <VoiceSettings value={voice} onChange={setVoice} />

        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Palette className="h-5 w-5 mr-2" />
            外观设置
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                窗口透明度
                <span className="ml-2 text-xs font-light">拖动可实时预览效果</span>
              </label>
              <div className="w-60 flex items-center gap-2">
                <span className="text-xs whitespace-nowrap">透明</span>
                <Slider
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={[opacity]}
                  onValueChange={(value) => setOpacity(value[0])}
                />
                <span className="text-xs whitespace-nowrap">不透明</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                回复字体大小
                <span className="ml-2 text-xs font-light">当前 {fontSize}px</span>
              </label>
              <div className="w-60 flex items-center gap-2">
                <span className="text-xs whitespace-nowrap">12px</span>
                <Slider
                  min={12}
                  max={24}
                  step={1}
                  value={[fontSize]}
                  onValueChange={(value) => setFontSize(value[0])}
                />
                <span className="text-xs whitespace-nowrap">24px</span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Keyboard className="h-5 w-5 mr-2" />
            快捷键设置
            <span className="text-sm font-light ml-2 mt-1">
              快捷键在问答页和记忆卡片页有效；Prompt 组默认使用 1~9、0、-、=。
            </span>
            <ResetDefaultShortcuts />
          </h2>
          <CustomShortcuts />
        </div>

        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Shield className="h-5 w-5 mr-2" />
            隐私设置
          </h2>
          <p className="text-sm">
            此应用为本地应用，采集的图片直接上传到您配置的 AI 大模型服务商，不存在隐私泄露风险。
          </p>
        </div>

        <div className="flex justify-center pb-4">
          <Button
            className="w-40 h-10 text-sm font-medium rounded-lg"
            onClick={handleSave}
            disabled={isSaving}
          >
            <Save className="h-4 w-4 mr-2" />
            保存设置
          </Button>
        </div>
      </div>
    </>
  )
}
