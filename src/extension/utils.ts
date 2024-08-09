import {
  ColorThemeKind,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  Position,
  Range,
  Terminal,
  TextDocument,
  WebviewView,
  window,
  workspace
} from 'vscode'
import * as util from 'util'
import { exec } from 'child_process'

const execAsync = util.promisify(exec)

import {
  Theme,
  LanguageType,
  apiProviders,
  StreamResponse,
  PrefixSuffix,
  Bracket,
  ServerMessageKey,
  Message,
  ChunkOptions,
  ServerMessage
} from '../common/types'
import { supportedLanguages } from '../common/languages'
import {
  ALL_BRACKETS,
  CLOSING_BRACKETS,
  EVENT_NAME,
  LINE_BREAK_REGEX,
  MULTILINE_TYPES,
  NORMALIZE_REGEX,
  OPENING_BRACKETS,
  QUOTES,
  QUOTES_REGEX,
  SKIP_DECLARATION_SYMBOLS,
  TWINNY
} from '../common/constants'
import { Logger } from '../common/logger'
import { SyntaxNode } from 'web-tree-sitter'
import { getParser } from './parser-utils'

const logger = new Logger()

export const delayExecution = <T extends () => void>(
  fn: T,
  delay = 200
): NodeJS.Timeout => {
  return setTimeout(() => {
    fn()
  }, delay)
}

export const getTextSelection = () => {
  const editor = window.activeTextEditor
  const selection = editor?.selection
  const text = editor?.document.getText(selection)
  return text || ''
}

export const getLanguage = (): LanguageType => {
  const editor = window.activeTextEditor
  const languageId = editor?.document.languageId
  const language =
    supportedLanguages[languageId as keyof typeof supportedLanguages]
  return {
    language,
    languageId
  }
}

export const getIsBracket = (char: string): char is Bracket => {
  return ALL_BRACKETS.includes(char as Bracket)
}

export const getIsClosingBracket = (char: string): char is Bracket => {
  return CLOSING_BRACKETS.includes(char as Bracket)
}

export const getIsOpeningBracket = (char: string): char is Bracket => {
  return OPENING_BRACKETS.includes(char as Bracket)
}

export const getIsSingleBracket = (chars: string) =>
  chars?.length === 1 && getIsBracket(chars)

export const getIsOnlyOpeningBrackets = (chars: string) => {
  if (!chars || !chars.length) return false

  for (const char of chars) {
    if (!getIsOpeningBracket(char)) {
      return false
    }
  }
  return true
}

export const getIsOnlyClosingBrackets = (chars: string) => {
  if (!chars || !chars.length) return false

  for (const char of chars) {
    if (!getIsClosingBracket(char)) {
      return false
    }
  }
  return true
}

export const getIsOnlyBrackets = (chars: string) => {
  if (!chars || !chars.length) return false

  for (const char of chars) {
    if (!getIsBracket(char)) {
      return false
    }
  }
  return true
}

export const getSkipVariableDeclataion = (
  characterBefore: string,
  textAfter: string
) => {
  if (
    characterBefore &&
    SKIP_DECLARATION_SYMBOLS.includes(characterBefore.trim()) &&
    textAfter.length &&
    (!textAfter.at(0) as unknown as string) === '?' &&
    !getIsOnlyBrackets(textAfter)
  ) {
    return true
  }

  return false
}

export const getShouldSkipCompletion = (
  context: InlineCompletionContext,
  autoSuggestEnabled: boolean
) => {
  const editor = window.activeTextEditor
  if (!editor) return true
  const document = editor.document
  const cursorPosition = editor.selection.active
  const lineEndPosition = document.lineAt(cursorPosition.line).range.end
  const textAfterRange = new Range(cursorPosition, lineEndPosition)
  const textAfter = document.getText(textAfterRange)
  const { charBefore } = getBeforeAndAfter()

  if (getSkipVariableDeclataion(charBefore, textAfter)) {
    return true
  }

  return (
    context.triggerKind === InlineCompletionTriggerKind.Automatic &&
    !autoSuggestEnabled
  )
}

export const getPrefixSuffix = (
  numLines: number,
  document: TextDocument,
  position: Position,
  contextRatio = [0.85, 0.15]
): PrefixSuffix => {
  const currentLine = position.line
  const numLinesToEnd = document.lineCount - currentLine
  let numLinesPrefix = Math.floor(Math.abs(numLines * contextRatio[0]))
  let numLinesSuffix = Math.ceil(Math.abs(numLines * contextRatio[1]))

  if (numLinesPrefix > currentLine) {
    numLinesSuffix += numLinesPrefix - currentLine
    numLinesPrefix = currentLine
  }

  if (numLinesSuffix > numLinesToEnd) {
    numLinesPrefix += numLinesSuffix - numLinesToEnd
    numLinesSuffix = numLinesToEnd
  }

  const prefixRange = new Range(
    Math.max(0, currentLine - numLinesPrefix),
    0,
    currentLine,
    position.character
  )
  const suffixRange = new Range(
    currentLine,
    position.character,
    currentLine + numLinesSuffix,
    0
  )

  return {
    prefix: document.getText(prefixRange),
    suffix: document.getText(suffixRange)
  }
}

export const getBeforeAndAfter = () => {
  const editor = window.activeTextEditor
  if (!editor)
    return {
      charBefore: '',
      charAfter: ''
    }

  const position = editor.selection.active
  const lineText = editor.document.lineAt(position.line).text

  const charBefore = lineText
    .substring(0, position.character)
    .trim()
    .split('')
    .reverse()[0]

  const charAfter = lineText.substring(position.character).trim().split('')[0]

  return {
    charBefore,
    charAfter
  }
}

export const getIsMiddleOfString = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return (
    charBefore && charAfter && /\w/.test(charBefore) && /\w/.test(charAfter)
  )
}

export const getCurrentLineText = (position: Position | null) => {
  const editor = window.activeTextEditor
  if (!editor || !position) return ''

  const lineText = editor.document.lineAt(position.line).text

  return lineText
}

export const getHasLineTextBeforeAndAfter = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return charBefore && charAfter
}

export const isCursorInEmptyString = () => {
  const { charBefore, charAfter } = getBeforeAndAfter()

  return QUOTES.includes(charBefore) && QUOTES.includes(charAfter)
}

export const getNextLineIsClosingBracket = () => {
  const editor = window.activeTextEditor
  if (!editor) return false
  const position = editor.selection.active
  const nextLineText = editor.document
    .lineAt(Math.min(position.line + 1, editor.document.lineCount - 1))
    .text.trim()
  return getIsOnlyClosingBrackets(nextLineText)
}

export const getPreviousLineIsOpeningBracket = () => {
  const editor = window.activeTextEditor
  if (!editor) return false
  const position = editor.selection.active
  const previousLineCharacter = editor.document
    .lineAt(Math.max(position.line - 1, 0))
    .text.trim()
    .split('')
    .reverse()[0]
  return getIsOnlyOpeningBrackets(previousLineCharacter)
}

export const getIsMultilineCompletion = ({
  node,
  prefixSuffix
}: {
  node: SyntaxNode | null
  prefixSuffix: PrefixSuffix | null
}) => {
  if (!node) return false

  const isMultilineCompletion =
    !getHasLineTextBeforeAndAfter() &&
    !isCursorInEmptyString() &&
    MULTILINE_TYPES.includes(node.type)

  return !!(isMultilineCompletion || !prefixSuffix?.suffix.trim())
}

export const getTheme = () => {
  const currentTheme = window.activeColorTheme
  if (currentTheme.kind === ColorThemeKind.Light) {
    return Theme.Light
  } else if (currentTheme.kind === ColorThemeKind.Dark) {
    return Theme.Dark
  } else {
    return Theme.Contrast
  }
}

export const getChatDataFromProvider = (
  provider: string,
  data: StreamResponse
) => {
  switch (provider) {
    case apiProviders.Ollama:
    case apiProviders.OpenWebUI:
      return data?.choices[0].delta?.content
        ? data?.choices[0].delta.content
        : ''
    case apiProviders.LlamaCpp:
      return data?.content
    case apiProviders.LiteLLM:
    default:
      if (data?.choices[0].delta.content === 'undefined') return ''
      return data?.choices[0].delta?.content
        ? data?.choices[0].delta.content
        : ''
  }
}

export const getFimDataFromProvider = (
  provider: string,
  data: StreamResponse | undefined
) => {
  switch (provider) {
    case apiProviders.Ollama:
    case apiProviders.OpenWebUI:
      return data?.response
    case apiProviders.LlamaCpp:
      return data?.content
    case apiProviders.LiteLLM:
      return data?.choices[0].delta.content
    default:
      if (!data?.choices.length) return
      if (data?.choices[0].text === 'undefined') {
        return ''
      }
      return data?.choices[0].text ? data?.choices[0].text : ''
  }
}

export function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith('data:')
}

export const getNoTextBeforeOrAfter = () => {
  const editor = window.activeTextEditor
  const cursorPosition = editor?.selection.active
  if (!cursorPosition) return
  const lastLinePosition = new Position(
    cursorPosition.line,
    editor.document.lineCount
  )
  const textAfterRange = new Range(cursorPosition, lastLinePosition)
  const textAfter = editor?.document.getText(textAfterRange)
  const textBeforeRange = new Range(new Position(0, 0), cursorPosition)
  const textBefore = editor?.document.getText(textBeforeRange)
  return !textAfter || !textBefore
}

export function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    if (isStreamWithDataPrefix(stringBuffer)) {
      return JSON.parse(stringBuffer.split('data:')[1])
    }
    return JSON.parse(stringBuffer)
  } catch (e) {
    return undefined
  }
}

export function safeParseJsonStringBuffer(
  stringBuffer: string
): unknown | undefined {
  try {
    return JSON.parse(stringBuffer.replace(NORMALIZE_REGEX, ''))
  } catch (e) {
    return undefined
  }
}

export function safeParseJson<T>(data: string): T | undefined {
  try {
    return JSON.parse(data)
  } catch (e) {
    return undefined
  }
}

export const getCurrentWorkspacePath = (): string | undefined => {
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    const workspaceFolder = workspace.workspaceFolders[0]
    return workspaceFolder.uri.fsPath
  } else {
    window.showInformationMessage('No workspace is open.')
    return undefined
  }
}

export const getGitChanges = async (): Promise<string> => {
  try {
    const path = getCurrentWorkspacePath()
    const { stdout } = await execAsync('git diff --cached', {
      cwd: path
    })
    return stdout
  } catch (error) {
    console.error('Error executing git command:', error)
    return ''
  }
}

export const getTerminal = async (): Promise<Terminal | undefined> => {
  const twinnyTerminal = window.terminals.find((t) => t.name === TWINNY)
  if (twinnyTerminal) return twinnyTerminal
  const terminal = window.createTerminal({ name: TWINNY })
  terminal.show()
  return terminal
}

export const getTerminalExists = (): boolean => {
  if (window.terminals.length === 0) {
    window.showErrorMessage('No active terminals')
    return false
  }
  return true
}

export function createSymmetryMessage<T>(
  key: ServerMessageKey,
  data?: T
): string {
  return JSON.stringify({ key, data })
}

export const getSanitizedCommitMessage = (commitMessage: string) => {
  const sanitizedMessage = commitMessage
    .replace(QUOTES_REGEX, '')
    .replace(LINE_BREAK_REGEX, '')
    .trim()

  return `git commit -m "${sanitizedMessage}"`
}

export const getNormalisedText = (text: string) =>
  text.replace(NORMALIZE_REGEX, ' ')

function getSplitChunks(node: SyntaxNode, options: ChunkOptions): string[] {
  const { minSize = 50, maxSize = 500 } = options
  const chunks: string[] = []

  function traverse(node: SyntaxNode) {
    if (node.text.length <= maxSize && node.text.length >= minSize) {
      chunks.push(node.text)
    } else if (node.children.length > 0) {
      for (const child of node.children) {
        traverse(child)
      }
    } else if (node.text.length > maxSize) {
      let start = 0
      while (start < node.text.length) {
        const end = Math.min(start + maxSize, node.text.length)
        chunks.push(node.text.slice(start, end))
        start = end
      }
    }
  }

  traverse(node)
  return chunks
}

export async function getDocumentSplitChunks(
  content: string,
  filePath: string,
  options: ChunkOptions = {}
): Promise<string[]> {
  const { minSize = 50, maxSize = 500, overlap = 50 } = options

  try {
    const parser = await getParser(filePath)

    if (!parser) {
      return simpleChunk(content, { minSize, maxSize, overlap })
    }

    const tree = parser.parse(content)
    const chunks = getSplitChunks(tree.rootNode, { minSize, maxSize })

    return combineChunks(chunks, { minSize, maxSize, overlap })
  } catch (error) {
    console.error(`Error parsing file ${filePath}: ${error}`)
    return simpleChunk(content, { minSize, maxSize, overlap })
  }
}

function combineChunks(chunks: string[], options: ChunkOptions): string[] {
  const { minSize = 50, maxSize = 500, overlap = 50 } = options
  const result: string[] = []
  let currentChunk = ''

  for (const chunk of chunks) {
    if (currentChunk.length + chunk.length > maxSize) {
      if (currentChunk.length >= minSize) {
        result.push(currentChunk)
        currentChunk = chunk
      } else {
        currentChunk += ' ' + chunk
      }
    } else {
      currentChunk += (currentChunk ? ' ' : '') + chunk
    }
    if (currentChunk.length >= maxSize - overlap) {
      result.push(currentChunk)
      currentChunk = currentChunk.slice(-overlap)
    }
  }

  if (currentChunk.length >= minSize) {
    result.push(currentChunk)
  }

  return result
}

function simpleChunk(content: string, options: ChunkOptions): string[] {
  const { minSize = 50, maxSize = 500, overlap = 50 } = options
  const chunks: string[] = []
  let start = 0

  while (start < content.length) {
    const end = Math.min(start + maxSize, content.length)
    const chunk = content.slice(start, end)

    try {
      chunks.push(chunk)
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message.includes('Invalid array length')
      ) {
        logger.log(
          'Maximum array size reached. Returning chunks processed so far.'
        )
        break
      } else {
        throw error
      }
    }

    start = end - overlap > start ? end - overlap : end

    if (end === content.length) break
  }

  return chunks.filter(
    (chunk, index) => chunk.length >= minSize || index === chunks.length - 1
  )
}

export const updateLoadingMessage = (
  view: WebviewView | undefined,
  message: string
) => {
  view?.webview.postMessage({
    type: EVENT_NAME.twinnySendLoader,
    value: {
      data: message
    }
  } as ServerMessage<string>)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const logStreamOptions = (opts: any) => {
  logger.log(
    `
***Twinny Stream Debug***\n\
Streaming response from ${opts.options.hostname}:${opts.options.port}.\n\
Request body:\n${JSON.stringify(opts.body, null, 2)}\n\n
Request options:\n${JSON.stringify(opts.options, null, 2)}\n\n
Number characters in all messages = ${opts.body.messages?.reduce(
      (acc: number, msg: Message) => {
        return msg.content?.length ? acc + msg.content?.length : 0
      },
      0
    )}\n\n
    `
  )
}
