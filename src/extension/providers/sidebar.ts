import * as vscode from 'vscode'

import {
  createSymmetryMessage,
  getGitChanges,
  getLanguage,
  getTextSelection,
  getTheme,
  updateLoadingMessage
} from '../utils'
import {
  WORKSPACE_STORAGE_KEY,
  EXTENSION_SESSION_NAME,
  EVENT_NAME,
  TWINNY_COMMAND_NAME,
  SYMMETRY_DATA_MESSAGE,
  SYMMETRY_EMITTER_KEY,
  SYSTEM,
} from '../../common/constants'
import { ChatService } from '../chat-service'
import {
  ClientMessage,
  Message,
  ApiModel,
  ServerMessage,
  InferenceRequest
} from '../../common/types'
import { TemplateProvider } from '../template-provider'
import { OllamaService } from '../ollama-service'
import { ProviderManager } from '../provider-manager'
import { ConversationHistory } from '../conversation-history'
import { EmbeddingDatabase } from '../embeddings'
import { SymmetryService } from '../symmetry-service'
import { SessionManager } from '../session-manager'
import { Logger } from '../../common/logger'

const logger = new Logger()

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _config = vscode.workspace.getConfiguration('twinny')
  private _context: vscode.ExtensionContext
  private _statusBar: vscode.StatusBarItem
  private _templateDir: string
  private _templateProvider: TemplateProvider
  private _ollamaService: OllamaService | undefined = undefined
  public conversationHistory: ConversationHistory | undefined = undefined
  public chatService: ChatService | undefined = undefined
  public view?: vscode.WebviewView
  private _db: EmbeddingDatabase | undefined
  public symmetryService?: SymmetryService | undefined
  private _sessionManager: SessionManager

  constructor(
    statusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext,
    templateDir: string,
    db: EmbeddingDatabase | undefined,
    sessionManager: SessionManager
  ) {
    this._statusBar = statusBar
    this._context = context
    this._templateDir = templateDir
    this._sessionManager = sessionManager
    this._templateProvider = new TemplateProvider(templateDir)
    this._ollamaService = new OllamaService()
    if (db) {
      this._db = db
    }
    return this
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView

    this.symmetryService = new SymmetryService(
      this.view,
      this._sessionManager,
      this._context
    )

    this.chatService = new ChatService(
      this._statusBar,
      this._templateDir,
      this._context,
      webviewView,
      this._db,
      this._sessionManager,
      this.symmetryService,
    )

    this.conversationHistory = new ConversationHistory(
      this._context,
      this.view,
      this._sessionManager,
      this.symmetryService
    )

    new ProviderManager(this._context, this.view)

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context?.extensionUri]
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    vscode.window.onDidChangeTextEditorSelection(
      (event: vscode.TextEditorSelectionChangeEvent) => {
        const text = event.textEditor.document.getText(event.selections[0])
        webviewView.webview.postMessage({
          type: EVENT_NAME.twinnyTextSelection,
          value: {
            type: WORKSPACE_STORAGE_KEY.selection,
            completion: text
          }
        })
      }
    )

    vscode.window.onDidChangeActiveColorTheme(() => {
      webviewView.webview.postMessage({
        type: EVENT_NAME.twinnySendTheme,
        value: {
          data: getTheme()
        }
      })
    })

    webviewView.webview.onDidReceiveMessage(
      (message: ClientMessage<string | boolean> & ClientMessage<Message[]>) => {
        const eventHandlers = {
          [EVENT_NAME.twinnyAcceptSolution]: this.acceptSolution,
          [EVENT_NAME.twinnyChatMessage]: this.streamChatCompletion,
          [EVENT_NAME.twinnyClickSuggestion]: this.clickSuggestion,
          [EVENT_NAME.twinnyFetchOllamaModels]: this.fetchOllamaModels,
          [EVENT_NAME.twinnyGlobalContext]: this.getGlobalContext,
          [EVENT_NAME.twinnyListTemplates]: this.listTemplates,
          [EVENT_NAME.twinnySetTab]: this.setTab,
          [TWINNY_COMMAND_NAME.settings]: this.openSettings,
          [EVENT_NAME.twinnyNewDocument]: this.createNewUntitledDocument,
          [EVENT_NAME.twinnyNotification]: this.sendNotification,
          [EVENT_NAME.twinnySendLanguage]: this.getCurrentLanguage,
          [EVENT_NAME.twinnySendTheme]: this.getTheme,
          [EVENT_NAME.twinnySetGlobalContext]: this.setGlobalContext,
          [EVENT_NAME.twinnySetWorkspaceContext]:
            this.setTwinnyWorkspaceContext,
          [EVENT_NAME.twinnyTextSelection]: this.getSelectedText,
          [EVENT_NAME.twinnyWorkspaceContext]: this.getTwinnyWorkspaceContext,
          [EVENT_NAME.twinnySetConfigValue]: this.setConfigurationValue,
          [EVENT_NAME.twinnyGetConfigValue]: this.getConfigurationValue,
          [EVENT_NAME.twinnyGetGitChanges]: this.getGitCommitMessage,
          [EVENT_NAME.twinnyHideBackButton]: this.twinnyHideBackButton,
          [EVENT_NAME.twinnyEmbedDocuments]: this.embedDocuments,
          [EVENT_NAME.twinnyConnectSymmetry]: this.connectToSymmetry,
          [EVENT_NAME.twinnyDisconnectSymmetry]: this.disconnectSymmetry,
          [EVENT_NAME.twinnySessionContext]: this.getSessionContext
        }
        eventHandlers[message.type as string]?.(message)
      }
    )
  }

  public openSettings() {
    vscode.commands.executeCommand(TWINNY_COMMAND_NAME.settings)
  }

  public setTab(tab: ClientMessage) {
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnySetTab,
      value: {
        data: tab as string
      }
    } as ServerMessage<string>)
  }

  public embedDocuments = async () => {
    const dirs = vscode.workspace.workspaceFolders
    if (!dirs?.length) {
      vscode.window.showErrorMessage('No workspace loaded.')
      return
    }
    if (!this._db) return
    for (const dir of dirs) {
      (await this._db.injestDocuments(dir.uri.fsPath)).populateDatabase()
    }
  }

  public getConfigurationValue = (data: ClientMessage) => {
    if (!data.key) return
    const config = vscode.workspace.getConfiguration('twinny')
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyGetConfigValue,
      value: {
        data: config.get(data.key as string),
        type: data.key
      }
    } as ServerMessage<string>)
  }

  public setConfigurationValue = (data: ClientMessage) => {
    if (!data.key) return
    const config = vscode.workspace.getConfiguration('twinny')
    config.update(data.key, data.data, vscode.ConfigurationTarget.Global)
  }

  public fetchOllamaModels = async () => {
    try {
      const models = await this._ollamaService?.fetchModels()
      if (!models?.length) {
        return
      }
      this.view?.webview.postMessage({
        type: EVENT_NAME.twinnyFetchOllamaModels,
        value: {
          data: models
        }
      } as ServerMessage<ApiModel[]>)
    } catch (e) {
      return
    }
  }

  public listTemplates = () => {
    const templates = this._templateProvider.listTemplates()
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyListTemplates,
      value: {
        data: templates
      }
    } as ServerMessage<string[]>)
  }

  public sendNotification = (data: ClientMessage) => {
    vscode.window.showInformationMessage(data.data as string)
  }

  public clickSuggestion = (data: ClientMessage) => {
    vscode.commands.executeCommand(
      'twinny.templateCompletion',
      data.data as string
    )
  }

  public streamChatCompletion = async (data: ClientMessage<Message[]>) => {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )
    if (symmetryConnected) {
      const systemMessage = {
        role: SYSTEM,
        content: await this._templateProvider?.readSystemMessageTemplate()
      }

      const messages = [systemMessage, ...(data.data as Message[])]

      updateLoadingMessage(this.view, 'Using symmetry for inference...')

      logger.log(`
        Using symmetry for inference
        Messages: ${JSON.stringify(messages)}
      `)

      return this.symmetryService?.write(
        createSymmetryMessage<InferenceRequest>(
          SYMMETRY_DATA_MESSAGE.inference,
          {
            messages,
            key: SYMMETRY_EMITTER_KEY.inference
          }
        )
      )
    }
    this.chatService?.streamChatCompletion(data.data || [])
  }

  public async streamTemplateCompletion(template: string) {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )
    if (symmetryConnected && this.chatService) {
      const messages = await this.chatService.getTemplateMessages(template)

      logger.log(`
        Using symmetry for inference
        Messages: ${JSON.stringify(messages)}
      `)
      return this.symmetryService?.write(
        createSymmetryMessage<InferenceRequest>(
          SYMMETRY_DATA_MESSAGE.inference,
          {
            messages,
            key: SYMMETRY_EMITTER_KEY.inference
          }
        )
      )
    }
    this.chatService?.streamTemplateCompletion(template)
  }

  public getSelectedText = () => {
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyTextSelection,
      value: {
        type: WORKSPACE_STORAGE_KEY.selection,
        completion: getTextSelection()
      }
    })
  }

  public acceptSolution = (data: ClientMessage) => {
    const editor = vscode.window.activeTextEditor
    const selection = editor?.selection
    if (!selection) return
    vscode.window.activeTextEditor?.edit((editBuilder) => {
      editBuilder.replace(selection, data.data as string)
    })
  }

  public createNewUntitledDocument = async (data: ClientMessage) => {
    const lang = getLanguage()
    const document = await vscode.workspace.openTextDocument({
      content: data.data as string,
      language: lang.languageId
    })
    await vscode.window.showTextDocument(document)
  }

  public getTheme = () => {
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnySendTheme,
      value: {
        data: getTheme()
      }
    })
  }

  public getCurrentLanguage = () => {
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnySendLanguage,
      value: {
        data: getLanguage()
      }
    } as ServerMessage)
  }

  public getGitCommitMessage = async () => {
    const diff = await getGitChanges()
    if (!diff.length) {
      vscode.window.showInformationMessage(
        'No changes found in the current workspace.'
      )
      return
    }
    this.conversationHistory?.resetConversation()
    this.chatService?.streamTemplateCompletion(
      'commit-message',
      diff,
      (completion: string) => {
        vscode.commands.executeCommand('twinny.sendTerminalText', completion)
      },
      true
    )
  }

  public getSessionContext = (data: ClientMessage) => {
    if (!data.key) return undefined
    this.view?.webview.postMessage({
      type: `${EVENT_NAME.twinnySessionContext}-${data.key}`,
      value: this._sessionManager.get(data.key)
    })
  }

  public getGlobalContext = (data: ClientMessage) => {
    const storedData = this._context?.globalState.get(
      `${EVENT_NAME.twinnyGlobalContext}-${data.key}`
    )
    this.view?.webview.postMessage({
      type: `${EVENT_NAME.twinnyGlobalContext}-${data.key}`,
      value: storedData
    })
  }

  public setGlobalContext = (data: ClientMessage) => {
    this._context?.globalState.update(
      `${EVENT_NAME.twinnyGlobalContext}-${data.key}`,
      data.data
    )
  }

  public getTwinnyWorkspaceContext = (data: ClientMessage) => {
    const storedData = this._context?.workspaceState.get(
      `${EVENT_NAME.twinnyWorkspaceContext}-${data.key}`
    )
    this.view?.webview.postMessage({
      type: `${EVENT_NAME.twinnyWorkspaceContext}-${data.key}`,
      value: storedData
    } as ServerMessage)
  }

  public setTwinnyWorkspaceContext = <T>(data: ClientMessage<T>) => {
    const value = data.data
    this._context.workspaceState.update(
      `${EVENT_NAME.twinnyWorkspaceContext}-${data.key}`,
      value
    )
    this.view?.webview.postMessage({
      type: `${EVENT_NAME.twinnyWorkspaceContext}-${data.key}`,
      value
    })
  }

  public newConversation() {
    this.symmetryService?.write(
      createSymmetryMessage(SYMMETRY_DATA_MESSAGE.newConversation)
    )
  }

  public destroyStream = () => {
    this.chatService?.destroyStream()
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    })
  }

  private connectToSymmetry = () => {
    if (this._config.symmetryServerKey) {
      this.symmetryService?.connect(this._config.symmetryServerKey)
    }
  }

  private disconnectSymmetry = async () => {
    if (this._config.symmetryServerKey) {
      await this.symmetryService?.disconnect()
    }
  }

  private twinnyHideBackButton() {
    vscode.commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton)
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'out', 'sidebar.js')
    )

    const codiconCssUri = vscode.Uri.joinPath(
      this._context.extensionUri,
      'assets',
      'codicon.css'
    )

    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'out', 'sidebar.css')
    )

    const codiconCssWebviewUri = webview.asWebviewUri(codiconCssUri)

    const nonce = getNonce()

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <link href="${codiconCssWebviewUri}" rel="stylesheet">
        <link href="${css}" rel="stylesheet">
        <meta charset="UTF-8">
				<meta
          http-equiv="Content-Security-Policy"
          content="default-src 'self' http://localhost:11434;
          img-src vscode-resource: https:;
          font-src vscode-webview-resource:;
          script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline' http: https: data:;"
        >
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sidebar</title>
        <style>
          body { padding: 10px }
        </style>
    </head>
    <body>
        <div id="root"></div>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
    </body>
    </html>`
  }
}

function getNonce() {
  let text = ''
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
