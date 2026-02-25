import { useState } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'

const defaultLanguages = [
  { value: 'python', label: 'Python3' },
  { value: 'java', label: 'Java' },
  { value: 'c++', label: 'C++' },
  { value: 'c#', label: 'C#' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'php', label: 'PHP' },
  { value: 'go', label: 'Go (Golang)' },
  { value: 'rust', label: 'Rust' },
  { value: 'sql', label: 'SQL' },
  { value: 'shell', label: 'Shell' }
]

export function SelectLanguage({
  value,
  onChange,
  disabled,
  className
}: {
  value?: string
  onChange?: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [languages, setLanguages] = useState(defaultLanguages)
  const [searchValue, setSearchValue] = useState('')

  const addCustomLanguage = (newLanguage: string) => {
    const trimmedLanguage = newLanguage.trim()
    if (!trimmedLanguage) return

    const newValue = trimmedLanguage.toLowerCase().replace(/\s+/g, '-')
    const newLabel = trimmedLanguage

    // Check if language already exists
    const exists = languages.some((lang) => lang.value === newValue)
    if (exists) return

    const newLanguageItem = { value: newValue, label: newLabel }
    setLanguages((prev) => [...prev, newLanguageItem])
    onChange?.(newValue)
    setSearchValue('')
    setOpen(false)
  }

  const filteredLanguages = languages.filter((language) =>
    language.label.toLowerCase().includes(searchValue.toLowerCase())
  )

  const showCreateOption =
    searchValue &&
    !filteredLanguages.some((lang) => lang.label.toLowerCase() === searchValue.toLowerCase())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-60 justify-between', className)}
        >
          {value ? languages.find((language) => language.value === value)?.label : '选择语言...'}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0">
        <Command>
          <CommandInput
            placeholder="搜索或添加语言..."
            className="h-9"
            value={searchValue}
            onValueChange={setSearchValue}
          />
          <CommandList>
            <CommandEmpty>没有找到语言</CommandEmpty>
            <CommandGroup>
              {filteredLanguages.map((language) => (
                <CommandItem
                  key={language.value}
                  value={language.value}
                  onSelect={(currentValue) => {
                    onChange?.(currentValue === value ? '' : currentValue)
                    setSearchValue('')
                    setOpen(false)
                  }}
                >
                  {language.label}
                  <Check
                    className={cn(
                      'ml-auto',
                      value === language.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
              {showCreateOption && (
                <CommandItem
                  value={`create-${searchValue}`}
                  onSelect={() => addCustomLanguage(searchValue)}
                  className="!text-blue-600"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  添加 &ldquo;{searchValue}&rdquo;
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
