// BB Chat Dock — the ChatGPT window.
//
// A small macOS app with one window: https://chatgpt.com in a WKWebView,
// without an address bar, navigation buttons or window buttons. It keeps its
// own website data store, so BB's built-in Browser and the agent tools that
// drive it (`bb browser`) never see this sign-in. Web Inspector is off.
//
// It talks only to the process that started it, through JSON lines on stdin
// and stdout. It never sends the page's content: only the document's address,
// the result of the plugin's own scripts (an address and a status word), and
// which of its own buttons the user pressed. Text is written into the page
// only after the user presses "Вставить в черновик" in this window.
import AppKit
import WebKit

let allowedHosts: Set<String> = [
  "chatgpt.com", "auth.openai.com", "auth0.openai.com",
  "accounts.google.com", "appleid.apple.com",
  "login.live.com", "login.microsoftonline.com",
]
let siteURL = URL(string: "https://chatgpt.com/")!
// Fixed: the window's sign-in survives restarts and stays out of BB's Browser.
let dataStoreID = UUID(uuidString: "5C0E5E2B-6F7D-4F8A-9C3B-2B7C1D0A9E41")!
let pageWorld = WKContentWorld.world(name: "bb-chat-dock")

func isAllowed(_ url: URL?) -> Bool {
  guard let url, url.scheme == "https", let host = url.host?.lowercased() else { return false }
  // The default port only, and no credentials in the address.
  if let port = url.port, port != 443 { return false }
  if url.user != nil || url.password != nil { return false }
  return allowedHosts.contains(host)
}

final class Channel {
  private let out = FileHandle.standardOutput
  private let lock = NSLock()
  func send(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    lock.lock(); defer { lock.unlock() }
    out.write(data)
  }
}

final class Panel: NSView {
  let status = NSTextField(wrappingLabelWithString: "")
  let preview = NSTextView()
  let insert = NSButton(title: "Вставить в черновик", target: nil, action: nil)
  let rebind = NSButton(title: "Выбрать открытую беседу", target: nil, action: nil)
  let copy = NSButton(title: "Скопировать", target: nil, action: nil)
  let dismiss = NSButton(title: "Отмена", target: nil, action: nil)

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    let border = NSBox(); border.boxType = .separator
    status.font = .systemFont(ofSize: 12)
    status.maximumNumberOfLines = 4
    preview.isEditable = false
    preview.isSelectable = true
    preview.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    preview.textContainerInset = NSSize(width: 4, height: 4)
    let scroll = NSScrollView()
    scroll.documentView = preview
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    preview.autoresizingMask = [.width]
    insert.keyEquivalent = ""
    insert.bezelColor = .controlAccentColor
    let buttons = NSStackView(views: [insert, rebind, copy, NSView(), dismiss])
    buttons.orientation = .horizontal
    buttons.spacing = 8
    let stack = NSStackView(views: [border, status, scroll, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 12, right: 12)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      border.widthAnchor.constraint(equalTo: stack.widthAnchor),
      scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24),
      scroll.heightAnchor.constraint(equalToConstant: 120),
      buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24),
      status.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24),
    ])
  }

  required init?(coder: NSCoder) { nil }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  let channel = Channel()
  var window: NSWindow!
  var webView: WKWebView!
  let panel = Panel()
  var panelText = ""
  var urlObservation: NSKeyValueObservation?

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let config = WKWebViewConfiguration()
    config.websiteDataStore = WKWebsiteDataStore(forIdentifier: dataStoreID)
    webView = WKWebView(frame: .zero, configuration: config)
    webView.isInspectable = false
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    webView.translatesAutoresizingMaskIntoConstraints = false

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "ChatGPT"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      window.standardWindowButton(kind)?.isHidden = true
    }
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("BBChatDockWindow")

    let content = NSView()
    panel.translatesAutoresizingMaskIntoConstraints = false
    panel.isHidden = true
    content.addSubview(webView)
    content.addSubview(panel)
    NSLayoutConstraint.activate([
      // The strip above the page stays the window's drag area.
      webView.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: panel.topAnchor),
      panel.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      panel.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      panel.bottomAnchor.constraint(equalTo: content.bottomAnchor),
    ])
    window.contentView = content
    for (button, action) in [(panel.insert, "insert"), (panel.rebind, "rebind"), (panel.copy, "copy"), (panel.dismiss, "dismiss")] {
      button.target = self
      button.action = #selector(pressed(_:))
      button.identifier = NSUserInterfaceItemIdentifier(action)
    }

    urlObservation = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
      self?.channel.send(["type": "url", "url": view.url?.absoluteString ?? ""])
    }
    loadStart()
    show()
    readCommands()
    channel.send(["type": "ready"])
  }

  func loadStart() {
    #if CHAT_DOCK_TEST
    // Test builds only: a synthetic page placed on the chatgpt.com origin
    // without any network request.
    if let file = ProcessInfo.processInfo.environment["CHAT_DOCK_TEST_HTML"],
       let html = try? String(contentsOfFile: file, encoding: .utf8),
       let path = ProcessInfo.processInfo.environment["CHAT_DOCK_TEST_PATH"] {
      webView.loadHTMLString(html, baseURL: URL(string: "https://chatgpt.com" + path))
      return
    }
    #endif
    webView.load(URLRequest(url: siteURL))
  }

  func show() {
    #if CHAT_DOCK_TEST
    if ProcessInfo.processInfo.environment["CHAT_DOCK_TEST_OFFSCREEN"] == "1" {
      window.setFrameOrigin(NSPoint(x: -5000, y: -5000))
      window.orderFrontRegardless()
      return
    }
    #endif
    if window.frameAutosaveName.isEmpty || !window.setFrameUsingName("BBChatDockWindow") { window.center() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Закрыть окно", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    appMenu.addItem(withTitle: "Выйти", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Правка")
    edit.addItem(withTitle: "Отменить", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Вырезать", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Копировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Выделить всё", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    NSApp.mainMenu = main
  }

  // MARK: Commands from the plugin

  func readCommands() {
    let input = FileHandle.standardInput
    Thread.detachNewThread { [weak self] in
      var buffer = Data()
      while true {
        let chunk = input.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0A) {
          let line = buffer.subdata(in: buffer.startIndex..<newline)
          buffer.removeSubrange(buffer.startIndex...newline)
          if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
            DispatchQueue.main.async { self?.handle(object) }
          }
        }
      }
      // The plugin went away: so does the window.
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  func handle(_ command: [String: Any]) {
    switch command["type"] as? String {
    case "show":
      show()
    case "panel":
      applyPanel(command)
    case "evaluate":
      guard let id = command["id"] as? String, let expression = command["expression"] as? String else { return }
      webView.evaluateJavaScript(expression, in: nil, in: pageWorld) { [weak self] result in
        switch result {
        case .success(let value):
          let json: Any = JSONSerialization.isValidJSONObject(["v": value]) ? value : NSNull()
          self?.channel.send(["type": "result", "id": id, "ok": true, "value": json])
        case .failure:
          self?.channel.send(["type": "result", "id": id, "ok": false])
        }
      }
    case "quit":
      NSApp.terminate(nil)
    #if CHAT_DOCK_TEST
    case "test-press":
      // Test builds only: stands in for the user's click on a panel button.
      if let action = command["action"] as? String { perform(action) }
    case "test-eval-main":
      // Test builds only: lets the stand drive its synthetic page.
      guard let id = command["id"] as? String, let expression = command["expression"] as? String else { return }
      webView.evaluateJavaScript(expression, in: nil, in: .page) { [weak self] result in
        if case .success(let value) = result, JSONSerialization.isValidJSONObject(["v": value]) {
          self?.channel.send(["type": "test-result", "id": id, "value": value])
        } else {
          self?.channel.send(["type": "test-result", "id": id, "value": NSNull()])
        }
      }
    case "test-reload":
      // A new document at the same address, as a reload of the real site gives.
      loadStart()
    #endif
    default:
      break
    }
  }

  func applyPanel(_ view: [String: Any]) {
    let visible = view["visible"] as? Bool ?? false
    panel.isHidden = !visible
    panel.status.stringValue = view["status"] as? String ?? ""
    panelText = view["text"] as? String ?? ""
    panel.preview.string = panelText
    panel.insert.isHidden = !(view["canInsert"] as? Bool ?? false)
    panel.rebind.isHidden = !(view["canRebind"] as? Bool ?? false)
    panel.copy.isHidden = !(view["canCopy"] as? Bool ?? false) || panelText.isEmpty
    panel.dismiss.title = view["dismissLabel"] as? String ?? "Отмена"
    panel.insert.isEnabled = !(view["busy"] as? Bool ?? false)
    if visible { show() }
  }

  @objc func pressed(_ sender: NSButton) {
    guard let action = sender.identifier?.rawValue else { return }
    perform(action)
  }

  func perform(_ action: String) {
    if action == "copy" {
      // The user's own click in this window writes the clipboard; nothing else does.
      let board = NSPasteboard.general
      board.clearContents()
      let ok = board.setString(panelText, forType: .string)
      channel.send(["type": "copied", "ok": ok])
      return
    }
    channel.send(["type": "pressed", "action": action])
  }

  // MARK: The fixed site

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    #if CHAT_DOCK_TEST
    if action.request.url?.scheme == "about" { decisionHandler(.allow); return }
    #endif
    let mainFrame = action.targetFrame?.isMainFrame ?? true
    if !mainFrame || isAllowed(action.request.url) {
      decisionHandler(.allow)
      return
    }
    // A link to another site opens in the default browser, on the user's click.
    if action.navigationType == .linkActivated, let url = action.request.url, url.scheme == "https" {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if isAllowed(action.request.url) {
      webView.load(action.request)
    } else if let url = action.request.url, url.scheme == "https" {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func windowWillClose(_ notification: Notification) {
    channel.send(["type": "closed"])
    NSApp.terminate(nil)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
