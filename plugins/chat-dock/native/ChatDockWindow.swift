// BB Chat Dock — the ChatGPT window.
//
// A small macOS app with one borderless window: https://chatgpt.com in a
// WKWebView, without an address bar, navigation or window buttons, and
// without a Dock icon. It covers BB's ChatGPT tab and follows BB's window,
// so ChatGPT looks and works as the content of that tab. It keeps its own persistent website data store: the sign-in survives
// restarts, and BB's built-in Browser and the agent tools that drive it
// (`bb browser`) never see it. Web Inspector is off.
//
// It talks only to the process that started it, through JSON lines on stdin:
// where to sit, and quit. It sends nothing about the page.
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
/// The only app whose windows may carry ChatGPT: BB Desktop. A placement
/// sent through the plugin's RPC cannot put ChatGPT over another app.
let ownerBundle = "dev.bb.desktop"
#if CHAT_DOCK_TEST
/// Test builds only: one more app the stand lets stand in for BB Desktop.
var testOwnerBundle: String?
#endif

func isOwnerApp(_ pid: pid_t) -> Bool {
  guard let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return false }
  #if CHAT_DOCK_TEST
  if let testOwnerBundle, id == testOwnerBundle { return true }
  #endif
  return id == ownerBundle || id.hasPrefix(ownerBundle + ".")
}

/// How far a window's frame is from what the page reported about its window.
func mismatch(_ b: CGRect, _ a: Attachment) -> Double {
  abs(b.minX - a.screen.x) + abs(b.minY - a.screen.y) + abs(b.width - a.outer.width) + abs(b.height - a.outer.height)
}

/// A window of BB Desktop that is in front (`ownerPID`): the page reports
/// while the user looks at it.
func findTarget(for a: Attachment, excluding own: Int, ownerPID: pid_t?) -> TargetWindow? {
  guard let ownerPID, ownerPID != getpid(), isOwnerApp(ownerPID) else { return nil }
  var best: (TargetWindow, Double)?
  for info in onScreenWindows() {
    guard (info[kCGWindowLayer as String] as? Int) == 0,
          let number = info[kCGWindowNumber as String] as? CGWindowID, Int(number) != own,
          (info[kCGWindowOwnerPID as String] as? pid_t) == ownerPID,
          let b = bounds(of: info) else { continue }
    let score = mismatch(b, a)
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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  let channel = Channel()
  var window: NSWindow!
  var webView: WKWebView!

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
    content.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: content.topAnchor),
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
    ])
    window.contentView = content
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
    // The window found earlier stays the target while the page still matches
    // it, even when ChatGPT itself is in front because the user typed there.
    if next.visible, let t = target, let current = currentBounds(of: t.number), mismatch(current, next) < 120,
       adopt(TargetWindow(number: t.number, bounds: current), for: next) {
      place()
      return
    }
    target = nil
    locate()
    place()
  }

  func currentBounds(of number: CGWindowID) -> CGRect? {
    onScreenWindows().first { ($0[kCGWindowNumber as String] as? CGWindowID) == number }.flatMap { bounds(of: $0) }
  }

  /// Finds the page's window for the current placement, if BB is in front.
  func locate() {
    guard let next = attachment, next.visible,
          let found = findTarget(for: next, excluding: window.windowNumber, ownerPID: frontmostPID()) else { return }
    _ = adopt(found, for: next)
  }

  /// Takes `found` as the target if the page's viewport, at the reported
  /// scale, fits inside that window; a scale that does not is refused.
  func adopt(_ found: TargetWindow, for next: Attachment) -> Bool {
    let backing = NSScreen.screens.first(where: { screenFrameCG($0).intersects(found.bounds) })?.backingScaleFactor ?? 2
    let scale = next.pixelRatio / Double(backing)
    guard next.inner.width * scale <= found.bounds.width + 2, next.inner.height * scale <= found.bounds.height + 2 else {
      target = nil
      return false
    }
    target = found
    zoom = scale
    chrome = CGPoint(x: max(0, found.bounds.width - next.inner.width * zoom),
                     y: max(0, found.bounds.height - next.inner.height * zoom))
    return true
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
    // Never past the page's window, whatever was reported.
    let cg = overlayRect(target: current, chrome: chrome, zoom: zoom, rect: a.rect).intersection(current)
    guard !cg.isNull, cg.width >= 40, cg.height >= 40 else {
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
    case "quit":
      NSApp.terminate(nil)
    #if CHAT_DOCK_TEST
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
    case "test-owner":
      testOwnerBundle = command["bundle"] as? String
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
