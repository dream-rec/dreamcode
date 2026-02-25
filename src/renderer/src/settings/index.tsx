import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  ArrowLeft,
  SquareTerminal,
  Palette,
  Shield,
  Bot,
  Eye,
  EyeOff,
  Keyboard,
  Save
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/lib/store/settings'
import { getCloneableFields } from '@/lib/utils'
import { SelectLanguage } from './SelectLanguage'
import { CustomShortcuts, ResetDefaultShortcuts } from './CustomShortcuts'

export default function SettingsPage() {
  const settingsStore = useSettingsStore()
  const navigate = useNavigate()

  // Local state - initialized from store, only committed on explicit save
  const [apiProvider, setApiProvider] = useState(settingsStore.apiProvider)
  const [apiBaseURL, setApiBaseURL] = useState(settingsStore.apiBaseURL)
  const [apiKey, setApiKey] = useState(settingsStore.apiKey)
  const [model, setModel] = useState(settingsStore.model)
  const [customPrompt, setCustomPrompt] = useState(settingsStore.customPrompt)
  const [codeLanguage, setCodeLanguage] = useState(settingsStore.codeLanguage)
  const [opacity, setOpacity] = useState(settingsStore.opacity)

  const [showApiKey, setShowApiKey] = useState(false)
  const [enableCustomPrompt, setEnableCustomPrompt] = useState(customPrompt.trim().length > 0)

  // Opacity real-time preview (direct DOM, not store)
  useEffect(() => {
    document.body.style.opacity = opacity.toString()
  }, [opacity])

  // Restore store opacity on unmount (store is unchanged if not saved)
  useEffect(() => {
    return () => {
      document.body.style.opacity = useSettingsStore.getState().opacity.toString()
    }
  }, [])

  const handleCustomPromptToggle = (checked: boolean) => {
    setEnableCustomPrompt(checked)
    if (!checked) {
      setCustomPrompt('')
    }
  }

  const commitSettings = () => {
    const newSettings = { apiProvider, apiBaseURL, apiKey, model, customPrompt, codeLanguage, opacity }
    settingsStore.syncSettings(newSettings)
    window.api.updateAppSettings(getCloneableFields({ ...settingsStore, ...newSettings }))
  }

  const handleSave = () => {
    commitSettings()
    toast.success('设置已保存')
  }

  const baseURLPlaceholder =
    apiProvider === 'anthropic'
      ? '无需加 /v1, 如 https://api.anthropic.com'
      : '如硅基流动为 https://api.siliconflow.cn/v1'

  return (
    <>
      {/* Header */}
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
            title="保存设置"
          >
            <Save className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Settings Content */}
      <div id="app-content" className="flex flex-col gap-4 p-8">
        {/* AI Settings */}
        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Bot className="h-5 w-5 mr-2" />
            AI 设置
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">API 类型</label>
              <div className="flex w-60 rounded-md overflow-hidden border border-gray-300 dark:border-gray-600">
                <button
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${
                    apiProvider === 'openai'
                      ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                      : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                  onClick={() => setApiProvider('openai')}
                >
                  OpenAI 兼容
                </button>
                <button
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${
                    apiProvider === 'anthropic'
                      ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                      : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                  onClick={() => setApiProvider('anthropic')}
                >
                  Claude
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                API Base URL
                <span className="ml-2 text-xs font-light">{baseURLPlaceholder}</span>
              </label>
              <input
                type="text"
                value={apiBaseURL}
                onChange={(e) => setApiBaseURL(e.target.value)}
                className="w-60 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="留空使用默认地址"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">API Key</label>
              <div className="flex items-center w-60">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-l-md bg-white dark:bg-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="输入 API Key"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="border border-l-0 rounded-l-none rounded-r-md h-9 w-9 hover:border-none"
                >
                  {showApiKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                Model
                <span className="ml-2 text-xs font-light">输入你的模型名称</span>
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-60 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={
                  apiProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o'
                }
              />
            </div>
          </div>
        </div>
        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <SquareTerminal className="h-5 w-5 mr-2" />
            解题设置
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                编程语言
                {enableCustomPrompt && (
                  <span className="ml-2 text-xs font-light">启用自定义提示词后，该选项失效</span>
                )}
              </label>
              <SelectLanguage
                value={codeLanguage}
                onChange={(value) => setCodeLanguage(value)}
                disabled={enableCustomPrompt}
                className={enableCustomPrompt ? 'line-through' : ''}
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                自定义提示词
                <span className="ml-2 text-xs font-light">
                  通过配置自定义提示词，可将应用能力快速扩展到编程以外的其他场景，用户也可以通过微调提示词来优化效果
                </span>
              </label>
              <Switch
                className="scale-y-90"
                checked={enableCustomPrompt}
                onCheckedChange={handleCustomPromptToggle}
              />
            </div>
            {enableCustomPrompt && (
              <div className="-mt-2">
                <Textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="请输入自定义的提示词内容, 示例: 你是一个编程助手, 请根据截图给出编程相关的回答。"
                  className="w-full min-h-24 bg-white dark:bg-gray-700 dark:text-gray-200"
                  rows={4}
                />
              </div>
            )}
          </div>
        </div>

        {/* Appearance Settings */}
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
                  onValueChange={(value) => {
                    setOpacity(value[0])
                  }}
                />
                <span className="text-xs whitespace-nowrap">不透明</span>
              </div>
            </div>
          </div>
        </div>

        {/* Shortcuts Settings */}
        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Keyboard className="h-5 w-5 mr-2" />
            快捷键设置
            <div className="text-sm font-light ml-2 mt-1">
              只有在主界面时，快捷键才有效。当前页面仅部分快捷键生效。
            </div>
            <ResetDefaultShortcuts />
          </h2>
          <CustomShortcuts />
        </div>

        {/* Privacy Settings */}
        <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Shield className="h-5 w-5 mr-2" />
            隐私设置
          </h2>

          <div className="space-y-4">
            <p className="text-sm">
              此应用为本地应用，采集的图片直接上传到您配置的 AI
              大模型服务商，不存在隐私泄露风险。
            </p>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-center pb-4">
          <Button
            className="w-40 h-10 text-sm font-medium rounded-lg"
            onClick={handleSave}
          >
            <Save className="h-4 w-4 mr-2" />
            保存设置
          </Button>
        </div>
      </div>
    </>
  )
}
