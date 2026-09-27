/**
 * Extract meaningful error message from API errors
 */
export function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error) || '未知错误'
  }

  // Try to extract responseBody from AI SDK errors
  const apiError = error as Error & {
    responseBody?: string
    statusCode?: number
    data?: unknown
  }

  // Try to parse responseBody for detailed message
  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody)
      if (body.message) {
        return body.message
      }
      if (body.error?.message) {
        return body.error.message
      }
    } catch {
      // If parsing fails, use responseBody as is
      if (typeof apiError.responseBody === 'string' && apiError.responseBody.length < 200) {
        return apiError.responseBody
      }
    }
  }

  // Fallback to error message
  return error.message || '未知错误'
}

/** Strips <think>…</think> blocks from a streamed response, tolerating tags split across chunks. */
export class ThinkTagStreamFilter {
  private carry = ''
  private thinkDepth = 0

  push(chunk: string): string {
    const input = this.carry + chunk
    this.carry = ''
    return this.parse(input, false)
  }

  finish(): string {
    if (!this.carry) return ''

    const trailing = this.carry
    this.carry = ''

    // At stream end, keep normal trailing text, but suppress unfinished think tags.
    if (this.looksLikePartialThinkTag(trailing)) {
      return ''
    }
    if (this.thinkDepth > 0) {
      return ''
    }
    return trailing
  }

  private parse(input: string, isFinal: boolean): string {
    let output = ''
    let i = 0

    while (i < input.length) {
      const ltIndex = input.indexOf('<', i)

      if (this.thinkDepth === 0) {
        if (ltIndex === -1) {
          output += input.slice(i)
          break
        }

        output += input.slice(i, ltIndex)
        const tagResult = this.tryConsumeThinkTag(input, ltIndex, isFinal)
        if (tagResult.kind === 'incomplete') {
          this.carry = input.slice(ltIndex)
          break
        }
        if (tagResult.kind === 'tag') {
          this.thinkDepth += tagResult.opening ? 1 : this.thinkDepth > 0 ? -1 : 0
          i = tagResult.nextIndex
          continue
        }

        output += '<'
        i = ltIndex + 1
        continue
      }

      if (ltIndex === -1) {
        break
      }

      const tagResult = this.tryConsumeThinkTag(input, ltIndex, isFinal)
      if (tagResult.kind === 'incomplete') {
        this.carry = input.slice(ltIndex)
        break
      }
      if (tagResult.kind === 'tag') {
        if (tagResult.opening) {
          this.thinkDepth += 1
        } else if (this.thinkDepth > 0) {
          this.thinkDepth -= 1
        }
        i = tagResult.nextIndex
        continue
      }

      i = ltIndex + 1
    }

    return output
  }

  private tryConsumeThinkTag(
    input: string,
    index: number,
    isFinal: boolean
  ):
    | { kind: 'tag'; opening: boolean; nextIndex: number }
    | { kind: 'incomplete' }
    | { kind: 'none' } {
    const closeIndex = input.indexOf('>', index)
    if (closeIndex === -1) {
      return isFinal ? { kind: 'none' } : { kind: 'incomplete' }
    }

    const rawTag = input.slice(index, closeIndex + 1)
    const match = rawTag.match(/^<\s*(\/?)\s*(think|thinking)\b[^>]*>$/i)
    if (!match) {
      return { kind: 'none' }
    }

    return {
      kind: 'tag',
      opening: match[1] !== '/',
      nextIndex: closeIndex + 1
    }
  }

  private looksLikePartialThinkTag(text: string): boolean {
    return /^<\s*\/?\s*think(?:ing)?[^>]*$/i.test(text)
  }
}
