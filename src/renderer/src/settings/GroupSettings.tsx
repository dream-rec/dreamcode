import { useMemo, useState } from 'react'
import { Check, Eye, EyeOff, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SelectLanguage } from './SelectLanguage'
import {
  createProviderGroup,
  createPromptGroup,
  type ProviderGroup,
  type PromptGroup
} from '../../../shared/settings'

interface GroupSettingsProps {
  providerGroups: ProviderGroup[]
  promptGroups: PromptGroup[]
  activeProviderGroupId: string
  activePromptGroupId: string
  onProviderGroupsChange: (groups: ProviderGroup[]) => void
  onPromptGroupsChange: (groups: PromptGroup[]) => void
  onProviderGroupSelect: (id: string) => void
  onPromptGroupSelect: (id: string) => void
}

export function GroupSettings({
  providerGroups,
  promptGroups,
  activeProviderGroupId,
  activePromptGroupId,
  onProviderGroupsChange,
  onPromptGroupsChange,
  onProviderGroupSelect,
  onPromptGroupSelect
}: GroupSettingsProps) {
  const [showApiKey, setShowApiKey] = useState(false)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const activeProvider = useMemo(
    () => providerGroups.find((group) => group.id === activeProviderGroupId) ?? providerGroups[0],
    [providerGroups, activeProviderGroupId]
  )
  const activePrompt = useMemo(
    () => promptGroups.find((group) => group.id === activePromptGroupId) ?? promptGroups[0],
    [promptGroups, activePromptGroupId]
  )
  const updateProvider = (changes: Partial<ProviderGroup>) => {
    if (!activeProvider) return
    onProviderGroupsChange(
      providerGroups.map((group) =>
        group.id === activeProvider.id ? { ...group, ...changes } : group
      )
    )
  }

  const updatePrompt = (changes: Partial<PromptGroup>) => {
    if (!activePrompt) return
    onPromptGroupsChange(
      promptGroups.map((group) => (group.id === activePrompt.id ? { ...group, ...changes } : group))
    )
  }

  const addProvider = () => {
    if (providerGroups.length >= 12) return
    const group = createProviderGroup(providerGroups.length)
    onProviderGroupsChange([...providerGroups, group])
    onProviderGroupSelect(group.id)
  }

  const addPrompt = () => {
    if (promptGroups.length >= 12) return
    const group = createPromptGroup(promptGroups.length)
    onPromptGroupsChange([...promptGroups, group])
    onPromptGroupSelect(group.id)
  }

  const removeProvider = () => {
    if (!activeProvider || providerGroups.length <= 1) return
    const nextGroups = providerGroups.filter((group) => group.id !== activeProvider.id)
    onProviderGroupsChange(nextGroups)
    onProviderGroupSelect(nextGroups[0].id)
  }

  const removePrompt = () => {
    if (!activePrompt || promptGroups.length <= 1) return
    const nextGroups = promptGroups.filter((group) => group.id !== activePrompt.id)
    onPromptGroupsChange(nextGroups)
    onPromptGroupSelect(nextGroups[0].id)
  }

  return (
    <>
      <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Provider 组</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              每组保存完整的 AI 服务配置，切换后下一轮请求生效
            </p>
          </div>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={addProvider}
              disabled={providerGroups.length >= 12}
            >
              <Plus className="h-4 w-4 mr-1" />
              新建
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={removeProvider}
              disabled={providerGroups.length <= 1}
              title="删除当前 Provider 组"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          {providerGroups.map((group, index) => (
            <div key={group.id} className="flex items-center gap-1">
              <GroupNameButton
                name={group.name || `Provider 组 ${index + 1}`}
                groupId={group.id}
                active={group.id === activeProvider?.id}
                editingGroupId={editingGroupId}
                editingName={editingName}
                onEditingNameChange={setEditingName}
                onSelect={() => onProviderGroupSelect(group.id)}
                onStartEditing={() => {
                  setEditingGroupId(group.id)
                  setEditingName(group.name)
                }}
                onCancelEditing={() => setEditingGroupId(null)}
                onSaveEditing={(name) => {
                  onProviderGroupsChange(
                    providerGroups.map((item) => (item.id === group.id ? { ...item, name } : item))
                  )
                  setEditingGroupId(null)
                }}
              />
            </div>
          ))}
        </div>
        {activeProvider && (
          <div className="space-y-4">
            <div className="flex rounded-md overflow-hidden border border-gray-300 dark:border-gray-600">
              {(['openai', 'anthropic'] as const).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={`flex-1 py-2 text-sm font-medium ${activeProvider.apiProvider === provider ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'bg-white text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
                  onClick={() => updateProvider({ apiProvider: provider })}
                >
                  {provider === 'openai' ? 'OpenAI 兼容' : 'Claude'}
                </button>
              ))}
            </div>
            <GroupInput
              label="API Base URL"
              value={activeProvider.apiBaseURL}
              onChange={(value) => updateProvider({ apiBaseURL: value })}
            />
            <div className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-sm">API Key</span>
              <div className="flex flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={activeProvider.apiKey}
                  onChange={(e) => updateProvider({ apiKey: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  className="ml-1 shrink-0"
                  title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                >
                  {showApiKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <GroupInput
              label="额外请求头"
              value={activeProvider.extraHeaders}
              onChange={(value) => updateProvider({ extraHeaders: value })}
              multiline
              placeholder='JSON，如 {"x-api-key":"your-key"}'
            />
            <GroupInput
              label="Model"
              value={activeProvider.model}
              onChange={(value) => updateProvider({ model: value })}
            />
            <GroupInput
              label="代理地址"
              value={activeProvider.proxyUrl}
              onChange={(value) => updateProvider({ proxyUrl: value })}
            />
          </div>
        )}
      </div>

      <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Prompt 组</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              每组保存编程语言和完整自定义提示词，切换后下一轮请求生效
            </p>
          </div>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={addPrompt}
              disabled={promptGroups.length >= 12}
            >
              <Plus className="h-4 w-4 mr-1" />
              新建
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={removePrompt}
              disabled={promptGroups.length <= 1}
              title="删除当前 Prompt 组"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          {promptGroups.map((group, index) => (
            <div key={group.id} className="flex items-center gap-1">
              <GroupNameButton
                name={group.name || `Prompt 组 ${index + 1}`}
                groupId={group.id}
                active={group.id === activePrompt?.id}
                editingGroupId={editingGroupId}
                editingName={editingName}
                onEditingNameChange={setEditingName}
                onSelect={() => onPromptGroupSelect(group.id)}
                onStartEditing={() => {
                  setEditingGroupId(group.id)
                  setEditingName(group.name)
                }}
                onCancelEditing={() => setEditingGroupId(null)}
                onSaveEditing={(name) => {
                  onPromptGroupsChange(
                    promptGroups.map((item) => (item.id === group.id ? { ...item, name } : item))
                  )
                  setEditingGroupId(null)
                }}
              />
            </div>
          ))}
        </div>
        {activePrompt && (
          <div className="space-y-4">
            <SelectLanguage
              value={activePrompt.codeLanguage}
              onChange={(value) => updatePrompt({ codeLanguage: value })}
            />
            <Textarea
              value={activePrompt.customPrompt}
              onChange={(e) => updatePrompt({ customPrompt: e.target.value })}
              placeholder="留空使用内置提示词；填写后使用自定义提示词"
              rows={7}
            />
          </div>
        )}
      </div>
    </>
  )
}

function GroupInput({
  label,
  value,
  type = 'text',
  onChange,
  multiline,
  placeholder
}: {
  label: string
  value: string
  type?: string
  onChange: (value: string) => void
  multiline?: boolean
  placeholder?: string
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <span className="w-28 shrink-0 pt-2">{label}</span>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="flex-1 font-mono text-xs"
        />
      ) : (
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </label>
  )
}

function GroupNameButton({
  name,
  groupId,
  active,
  editingGroupId,
  editingName,
  onEditingNameChange,
  onSelect,
  onStartEditing,
  onCancelEditing,
  onSaveEditing
}: {
  name: string
  groupId: string
  active: boolean
  editingGroupId: string | null
  editingName: string
  onEditingNameChange: (name: string) => void
  onSelect: () => void
  onStartEditing: () => void
  onCancelEditing: () => void
  onSaveEditing: (name: string) => void
}) {
  if (editingGroupId === groupId) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          autoFocus
          value={editingName}
          onChange={(event) => onEditingNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSaveEditing(editingName.trim() || name)
            if (event.key === 'Escape') onCancelEditing()
          }}
          className="h-8 w-32 px-2 text-sm"
        />
        <button
          type="button"
          className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
          onClick={() => onSaveEditing(editingName.trim() || name)}
          title="保存名称"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
          onClick={onCancelEditing}
          title="取消编辑"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        className={`rounded-md border px-3 py-1.5 text-sm ${active ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900' : 'border-gray-300 dark:border-gray-600'}`}
      >
        {name}
      </button>
      {active && (
        <button
          type="button"
          className="rounded p-1 opacity-70 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10"
          onClick={onStartEditing}
          title="编辑组名称"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </>
  )
}
