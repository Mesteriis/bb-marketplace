// BB Chat Dock — the ChatGPT window.
//
// A small macOS app with one borderless window: https://chatgpt.com in a
// WKWebView, without an address bar, navigation or window buttons, and
// without a Dock icon. It sits on the place the BB page reserves for it and
// follows the window that shows that page, so it looks and works as part of
// BB. It keeps its own persistent website data store: the sign-in survives
// restarts, and BB's built-in Browser and the agent tools that drive it
// (`bb browser`) never see it. Web Inspector is off.
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
#if CHAT_DOCK_TEST
let dataStoreID = UUID(uuidString: "0B7E1A55-7E57-4C0D-8A1D-0000C4A7D0C5")!
#else
let dataStoreID = UUID(uuidString: "5C0E5E2B-6F7D-4F8A-9C3B-2B7C1D0A9E41")!
#endif
let pageWorld = WKContentWorld.world(name: "bb-chat-dock")

func isAllowed(_ url: URL?) -> Bool {
  guard let url, url.scheme == "https", let host = url.host?.lowercased() else { return false }
  // The default port only, and no credentials in the address.
  if let port = url.port, port != 443 { return false }
  if url.user != nil || url.password != nil { return false }
  return allowedHosts.contains(host)
}

/// A borderless window that still takes the keyboard. With no menu bar of its
/// own, it maps the standard editing shortcuts itself.
final class OverlayWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if super.performKeyEquivalent(with: event) { return true }
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
    let action: Selector?
    switch (flags, key) {
    case (.command, "x"): action = #selector(NSText.cut(_:))
    case (.command, "c"): action = #selector(NSText.copy(_:))
    case (.command, "v"): action = #selector(NSText.paste(_:))
    case (.command, "a"): action = #selector(NSText.selectAll(_:))
    case (.command, "z"): action = Selector(("undo:"))
    case ([.command, .shift], "z"): action = Selector(("redo:"))
    default: action = nil
    }
    guard let action else { return false }
    return NSApp.sendAction(action, to: nil, from: self)
  }
}

/// Where the BB page wants the window: its reserved area in CSS pixels and
/// the page's viewport, as the page measured them.
struct Attachment {
  var visible: Bool
  var rect: CGRect
  var inner: CGSize
  var outer: CGSize
  var screen: CGPoint
  var pixelRatio: Double

  init?(_ c: [String: Any]) {
    func number(_ key: String) -> Double? { (c[key] as? NSNumber)?.doubleValue }
    guard let visible = c["visible"] as? Bool else { return nil }
    self.visible = visible
    guard let x = number("x"), let y = number("y"), let w = number("width"), let h = number("height"),
          let iw = number("innerWidth"), let ih = number("innerHeight"),
          let ow = number("outerWidth"), let oh = number("outerHeight"),
          let sx = number("screenX"), let sy = number("screenY"), let dpr = number("pixelRatio"),
          [x, y, w, h, iw, ih, ow, oh, sx, sy, dpr].allSatisfy({ $0.isFinite }), dpr > 0, iw > 0, ih > 0
    else {
      if visible { return nil }
      self.rect = .zero; self.inner = .zero; self.outer = .zero; self.screen = .zero; self.pixelRatio = 1
      return
    }
    // The area must lie inside the page's viewport and the viewport inside
    // the page's window: the window never covers more than the page.
    if visible && !(x >= 0 && y >= 0 && x + w <= iw + 1 && y + h <= ih + 1 && iw <= ow + 1 && ih <= oh + 1) {
      return nil
    }
    rect = CGRect(x: x, y: y, width: w, height: h)
    inner = CGSize(width: iw, height: ih)
    outer = CGSize(width: ow, height: oh)
    screen = CGPoint(x: sx, y: sy)
    pixelRatio = dpr
  }
}

/// The window that shows the BB page, as the window server reports it.
struct TargetWindow {
  let number: CGWindowID
  let bounds: CGRect
}

func onScreenWindows() -> [[String: Any]] {
  (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}

func bounds(of info: [String: Any]) -> CGRect? {
  guard let dict = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: dict)
}

/// The ordinary window of another app whose frame best matches what the page
/// reported about its own window.
/// Only a window of `ownerPID`, the app in front: the page reports while the
/// user looks at it, and a placement sent from elsewhere cannot put ChatGPT
/// over an app the user is not using.
func findTarget(for a: Attachment, excluding own: Int, ownerPID: pid_t?) -> TargetWindow? {
  guard let ownerPID, ownerPID != getpid() else { return nil }
  var best: (TargetWindow, Double)?
  for info in onScreenWindows() {
    guard (info[kCGWindowLayer as String] as? Int) == 0,
          let number = info[kCGWindowNumber as String] as? CGWindowID, Int(number) != own,
          (info[kCGWindowOwnerPID as String] as? pid_t) == ownerPID,
          let b = bounds(of: info) else { continue }
    let score = abs(b.minX - a.screen.x) + abs(b.minY - a.screen.y) + abs(b.width - a.outer.width) + abs(b.height - a.outer.height)
    if score < 120, best == nil || score < best!.1 { best = (TargetWindow(number: number, bounds: b), score) }
  }
  return best?.0
}

/// The overlay's frame in window-server coordinates (top-left origin), given
/// the target's current bounds. Browser chrome is assumed to sit on the left
/// and top of the page, as in BB Desktop, Chrome-family browsers and Safari.
func overlayRect(target: CGRect, chrome: CGPoint, zoom: Double, rect: CGRect) -> CGRect {
  CGRect(x: target.minX + chrome.x + rect.minX * zoom,
         y: target.minY + chrome.y + rect.minY * zoom,
         width: rect.width * zoom,
         height: rect.height * zoom)
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

    window = OverlayWindow(
      contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
      styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.title = "ChatGPT"
    window.hasShadow = false
    window.isOpaque = true
    window.backgroundColor = .windowBackgroundColor
    window.collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
    window.delegate = self
    window.isReleasedWhenClosed = false

    let content = NSView()
    panel.translatesAutoresizingMaskIntoConstraints = false
    panel.isHidden = true
    content.addSubview(webView)
    content.addSubview(panel)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: content.topAnchor),
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
    #if CHAT_DOCK_TEST
    if ProcessInfo.processInfo.environment["CHAT_DOCK_TEST_OFFSCREEN"] == "1" {
      // WebKit needs a window on screen; keep it out of sight.
      window.setFrame(NSRect(x: -5000, y: -5000, width: 800, height: 600), display: false)
      window.orderFrontRegardless()
    }
    #endif
    startTracking()
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

  // MARK: Sitting on the BB page

  var attachment: Attachment?
  var target: TargetWindow?
  var chrome = CGPoint.zero
  var zoom = 1.0
  var tracker: Timer?
  #if CHAT_DOCK_TEST
  var testFrontPID: pid_t?
  #endif

  func frontmostPID() -> pid_t? {
    #if CHAT_DOCK_TEST
    if let testFrontPID { return testFrontPID }
    #endif
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  func attach(_ next: Attachment) {
    attachment = next
    target = nil
    locate()
    place()
  }

  /// Finds the page's window for the current placement, if its app is in front.
  func locate() {
    guard let next = attachment, next.visible else { return }
    if let found = findTarget(for: next, excluding: window.windowNumber, ownerPID: frontmostPID()) {
      target = found
      let backing = NSScreen.screens.first(where: { screenFrameCG($0).intersects(found.bounds) })?.backingScaleFactor ?? 2
      zoom = next.pixelRatio / Double(backing)
      chrome = CGPoint(x: max(0, found.bounds.width - next.inner.width * zoom),
                       y: max(0, found.bounds.height - next.inner.height * zoom))
    }
  }

  /// A screen's frame in window-server coordinates (top-left origin).
  func screenFrameCG(_ screen: NSScreen) -> CGRect {
    let primary = NSScreen.screens.first?.frame.height ?? screen.frame.maxY
    return CGRect(x: screen.frame.minX, y: primary - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
  }

  func startTracking() {
    let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.place() }
    RunLoop.main.add(timer, forMode: .common)
    tracker = timer
  }

  /// Puts the window on the page's reserved area, just above the page's
  /// window, or hides it when the page is gone, hidden or off screen.
  func place() {
    #if CHAT_DOCK_TEST
    if attachment == nil, ProcessInfo.processInfo.environment["CHAT_DOCK_TEST_OFFSCREEN"] == "1" { return }
    #endif
    if let a = attachment, a.visible, target == nil { locate() }
    guard let a = attachment, a.visible, let t = target else {
      if window.isVisible { window.orderOut(nil) }
      return
    }
    let windows = onScreenWindows()
    let targetIndex = windows.firstIndex { ($0[kCGWindowNumber as String] as? CGWindowID) == t.number }
    guard let targetIndex, let current = bounds(of: windows[targetIndex]) else {
      // Minimized, on another Space or closed.
      if window.isVisible { window.orderOut(nil) }
      return
    }
    let cg = overlayRect(target: current, chrome: chrome, zoom: zoom, rect: a.rect)
    guard cg.width >= 40, cg.height >= 40 else {
      if window.isVisible { window.orderOut(nil) }
      return
    }
    let primary = NSScreen.screens.first?.frame.height ?? 0
    let frame = NSRect(x: cg.minX, y: primary - cg.maxY, width: cg.width, height: cg.height)
    if abs(window.frame.minX - frame.minX) > 0.5 || abs(window.frame.minY - frame.minY) > 0.5
      || abs(window.frame.width - frame.width) > 0.5 || abs(window.frame.height - frame.height) > 0.5 {
      window.setFrame(frame, display: true)
    }
    let ownIndex = windows.firstIndex { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }
    if !window.isVisible || ownIndex == nil || ownIndex! > targetIndex {
      window.order(.above, relativeTo: Int(t.number))
    }
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    // A borderless window has no close button for performClose to press.
    let close = appMenu.addItem(withTitle: "Закрыть окно", action: #selector(closeWindow(_:)), keyEquivalent: "w")
    close.target = self
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
    case "attach":
      if let next = Attachment(command) { attach(next) }
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
    case "test-front":
      // Test builds only: which app counts as the one in front.
      testFrontPID = (command["pid"] as? NSNumber).map { pid_t($0.int32Value) }
    case "test-close-key":
      // Test builds only: ⌘W as the menu receives it.
      if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                      windowNumber: window.windowNumber, context: nil, characters: "w",
                                      charactersIgnoringModifiers: "w", isARepeat: false, keyCode: 13) {
        if !(window.performKeyEquivalent(with: event)) { _ = NSApp.mainMenu?.performKeyEquivalent(with: event) }
      }
    case "test-reload":
      // A new document at the same address, as a reload of the real site gives.
      loadStart()
    case "test-state":
      // Test builds only: where the window is, in window-server coordinates.
      guard let id = command["id"] as? String else { return }
      let primary = NSScreen.screens.first?.frame.height ?? 0
      let f = window.frame
      let windows = onScreenWindows()
      let ownIndex = windows.firstIndex { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }
      let targetIndex = target.flatMap { t in windows.firstIndex { ($0[kCGWindowNumber as String] as? CGWindowID) == t.number } }
      channel.send(["type": "test-result", "id": id, "value": [
        "visible": window.isVisible,
        "x": f.minX, "y": primary - f.maxY, "width": f.width, "height": f.height,
        "target": target.map { Int($0.number) } ?? -1,
        "aboveTarget": ownIndex != nil && targetIndex != nil && ownIndex! < targetIndex!,
      ] as [String: Any]])
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

  @objc func closeWindow(_ sender: Any?) {
    window.close()
  }

  func windowWillClose(_ notification: Notification) {
    channel.send(["type": "closed"])
    NSApp.terminate(nil)
  }

  // The window hides while the page's window is minimized or gone; that is
  // not a reason to quit. Closing it quits in windowWillClose.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

let app = NSApplication.shared
// No Dock icon and no menu bar: the window is part of BB's interface.
app.setActivationPolicy(.accessory)
// A hidden window still holds the user's draft and sign-in: the system must
// not stop the app because nothing of it is on screen.
ProcessInfo.processInfo.disableAutomaticTermination("ChatGPT window is attached to BB")
ProcessInfo.processInfo.disableSuddenTermination()
let delegate = AppDelegate()
app.delegate = delegate
app.run()
