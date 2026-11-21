// The call page: a standalone document the plugin serves and BB shows in an
// iframe on a loopback origin of its own (never BB's origin). Zoom's Meeting SDK (component view) injects a global
// stylesheet and needs React 18, so it gets a document of its own. The page
// holds no secrets: the parent posts the signature and ZAK for one meeting.
//
// Messages (all `{ type: "zoom-call:…" }`):
//   page → parent: ready | failed {message} | joined | ended | error {code, message}
//                  | media-error {kind: camera|microphone|screen, name, message}
//   parent → page: join {call} | leave

/** Pinned so a Zoom release cannot change the code the page runs. Update with the SDK notes. */
export const MEETING_SDK_VERSION = "6.10.0";

const VENDOR = ["react", "react-dom", "redux", "redux-thunk", "react-redux", "lodash"] as const;

/** Zoom's documented policy (Meeting SDK browser support), without 'self': the page loads nothing from BB. */
export const CALL_PAGE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  // BB embeds the page from the other loopback name (see callPageUrlFor).
  "frame-ancestors http://127.0.0.1:* http://localhost:*",
  "form-action 'none'",
  "worker-src blob:",
  "style-src 'unsafe-inline' https://zoom.us https://*.zoom.us",
  "script-src 'unsafe-inline' 'unsafe-eval' https://zoom.us https://*.zoom.us https://dmogdx0jrul3u.cloudfront.net blob:",
  "connect-src https://zoom.us https://*.zoom.us wss://*.zoom.us https://zoom.com https://*.zoom.com wss://*.zoom.com",
  "img-src https: data: blob:",
  "media-src https: blob:",
  "font-src https: data:",
].join("; ");

/**
 * Runs before Zoom's scripts: tells the parent why the browser refused the
 * camera, microphone or screen, which Zoom's own UI does not explain. The
 * refusal still reaches the SDK unchanged.
 */
export const MEDIA_REPORT_SCRIPT = `
(function () {
  var media = navigator.mediaDevices;
  if (!media) return;
  function report(kind, error) {
    window.parent.postMessage({
      type: "zoom-call:media-error",
      kind: kind,
      name: String((error && error.name) || "Error"),
      message: String((error && error.message) || "").slice(0, 200)
    }, "*");
  }
  function wrap(method, kindOf) {
    var original = media[method];
    media[method] = function (constraints) {
      var kind = kindOf(constraints);
      var result;
      if (typeof original !== "function") {
        result = Promise.reject(new DOMException("Screen capture is not available here", "NotSupportedError"));
      } else {
        try { result = Promise.resolve(original.call(media, constraints)); } catch (error) { result = Promise.reject(error); }
      }
      result.catch(function (error) { report(kind, error); });
      return result;
    };
  }
  wrap("getUserMedia", function (constraints) { return constraints && constraints.video ? "camera" : "microphone"; });
  wrap("getDisplayMedia", function () { return "screen"; });
})();
`;

/**
 * Runs on the call page. Exported so tests can execute it against a stand-in
 * SDK. Embedded in BB it talks to the parent window; opened on its own (a
 * ticket link in the system browser) it joins the call it was served with
 * and reports on the page itself.
 */
export const CALL_PAGE_SCRIPT = `
(function () {
  var parentWindow = window.parent;
  var standalone = parentWindow === window;
  var notice = document.getElementById("notice");
  function say(text) { if (notice) notice.textContent = text; }
  function post(message) {
    if (!standalone) { parentWindow.postMessage(message, "*"); return; }
    if (message.type === "zoom-call:failed") say(message.message);
    if (message.type === "zoom-call:error") say("Zoom отклонил вход: " + message.message + " (код " + message.code + ")");
    if (message.type === "zoom-call:joined") say("");
    if (message.type === "zoom-call:ended") say("Звонок завершён. Эту вкладку можно закрыть.");
  }
  var served = standalone ? window.__ZOOM_CALL__ : null;
  if (standalone && !served) {
    say("Эта страница открывается из плагина Makosh Zoom в BB.");
    return;
  }
  if (typeof ZoomMtgEmbedded === "undefined") {
    post({ type: "zoom-call:failed", message: "Не удалось загрузить Zoom Meeting SDK" });
    return;
  }
  function describe(error) {
    var code = error && (error.errorCode !== undefined ? error.errorCode : error.type);
    var message = error && (error.reason || error.message);
    return { code: String(code === undefined ? "unknown" : code), message: String(message || "Zoom отклонил вход") };
  }

  // Zoom derives the view's height from its width (16:9 video plus its own
  // controls), so the view is fitted by width and refitted on every resize.
  var CONTROLS_HEIGHT = 92;
  var MIN_WIDTH = 320;
  function fit() {
    var byWidth = window.innerWidth - 4;
    var byHeight = Math.floor((window.innerHeight - CONTROLS_HEIGHT) * 16 / 9);
    var width = Math.max(MIN_WIDTH, Math.min(byWidth, byHeight));
    client.updateVideoOptions({
      isResizable: false,
      popper: { disableDraggable: true, anchorPosition: { top: 0, left: Math.max(0, Math.floor((window.innerWidth - width - 4) / 2)) } },
      viewSizes: { default: { width: width, height: Math.floor(width * 9 / 16) } }
    });
  }

  var client = null;
  var joined = false;
  var ready;
  try {
    client = ZoomMtgEmbedded.createClient();
    ready = Promise.resolve(client.init({
      zoomAppRoot: document.getElementById("meetingSDKElement"),
      language: "ru-RU",
      patchJsMedia: true
    })).then(function () {
      // The SDK throws on on() until init() has finished.
      client.on("connection-change", function (payload) {
        if (payload && payload.state === "Connected") { joined = true; fit(); post({ type: "zoom-call:joined" }); }
        if (payload && payload.state === "Closed") { joined = false; post({ type: "zoom-call:ended" }); }
      });
    });
  } catch (error) {
    ready = Promise.reject(error);
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (joined) { try { fit(); } catch (error) { /* the next resize tries again */ } }
    }, 150);
  });

  function join(call) {
    ready.then(function () {
      return client.join({
        signature: call.signature,
        meetingNumber: call.meetingNumber,
        password: call.passcode || "",
        userName: call.userName,
        zak: call.zak
      });
    }).catch(function (error) {
      var info = describe(error);
      post({ type: "zoom-call:error", code: info.code, message: info.message });
    });
  }

  var THEME_KEYS = ["background", "foreground", "card", "popover", "border", "input", "primary", "primaryForeground", "muted", "mutedForeground", "destructive", "font"];
  function applyTheme(colors) {
    if (!colors || typeof colors !== "object") return;
    THEME_KEYS.forEach(function (key) {
      var value = colors[key];
      if (typeof value === "string" && value !== "" && value.length <= 200) {
        document.documentElement.style.setProperty("--bb-" + key, value);
      }
    });
  }

  ready.then(function () {
    post({ type: "zoom-call:ready" });
    if (standalone) join(served);
  }, function (error) {
    post({ type: "zoom-call:failed", message: "Zoom Meeting SDK не запустился: " + describe(error).message });
  });
  window.addEventListener("message", function (event) {
    if (standalone || event.source !== parentWindow || !event.data) return;
    if (event.data.type === "zoom-call:theme") applyTheme(event.data.colors);
    if (event.data.type === "zoom-call:join" && event.data.call && !joined) join(event.data.call);
    if (event.data.type === "zoom-call:leave" && joined) {
      try { client.leaveMeeting(); } catch (error) { post({ type: "zoom-call:ended" }); }
    }
  });
})();
`;

/**
 * BB's colours over Zoom's component view. The variables are set from the
 * host's theme; the defaults are a neutral dark. Zoom's MUI class names are
 * not a stable interface: recheck these rules when MEETING_SDK_VERSION moves.
 */
const THEME_CSS = `
:root {
  --bb-background: #16161a; --bb-foreground: #e4e4e7; --bb-card: #1d1d22; --bb-popover: #1d1d22;
  --bb-border: #2e2e35; --bb-input: #3f3f46; --bb-primary: #8b5cf6; --bb-primaryForeground: #0a0a0a;
  --bb-muted: #26262c; --bb-mutedForeground: #a1a1aa; --bb-destructive: #ef4444;
  --bb-font: system-ui, -apple-system, "Segoe UI", sans-serif;
}
html, body { margin: 0; height: 100%; background: var(--bb-background); color: var(--bb-foreground); font-family: var(--bb-font); }
#meetingSDKElement { min-height: 100%; }
#notice { font-size: 14px; line-height: 1.5; text-align: center; padding: 0 16px; }
#notice:not(:empty) { padding: 16px; }
#meetingSDKElement .zoom-MuiPaper-root,
body > .zoom-MuiPopper-root .zoom-MuiPaper-root,
body > .zoom-MuiPopover-root .zoom-MuiPaper-root,
body > .zoom-MuiDialog-root .zoom-MuiPaper-root,
body > .zoom-MuiMenu-root .zoom-MuiPaper-root {
  background-color: var(--bb-card) !important; color: var(--bb-foreground) !important;
  background-image: none !important; box-shadow: none !important; border: 1px solid var(--bb-border);
}
.zoom-MuiListItem-root { background-color: var(--bb-muted) !important; color: var(--bb-foreground) !important; }
.zoom-MuiTypography-root, .zoom-MuiInputBase-root, .zoom-MuiFormLabel-root, .zoom-MuiTab-root { color: inherit !important; font-family: var(--bb-font) !important; }
.zoom-MuiButtonBase-root { font-family: var(--bb-font) !important; }
.zoom-MuiTooltip-tooltip {
  background-color: var(--bb-popover) !important; color: var(--bb-foreground) !important;
  border: 1px solid var(--bb-border); font-family: var(--bb-font) !important;
}
.zoom-MuiDivider-root { border-color: var(--bb-border) !important; }
.zoom-MuiOutlinedInput-notchedOutline { border-color: var(--bb-input) !important; }
.zoom-MuiTabs-indicator { background-color: var(--bb-primary) !important; }
.zoom-MuiTab-root.Mui-selected { color: var(--bb-primary) !important; }
.zoom-MuiButton-containedPrimary { background-color: var(--bb-primary) !important; color: var(--bb-primaryForeground) !important; }
.zoom-MuiButton-textPrimary, .zoom-MuiButton-outlinedPrimary { color: var(--bb-foreground) !important; }
.zoom-MuiMenuItem-root:hover, .zoom-MuiListItemButton-root:hover { background-color: var(--bb-muted) !important; }
`;

/** A call to join without a parent window: the page was opened by a ticket link. */
export interface ServedCall {
  readonly signature: string;
  readonly meetingNumber: string;
  readonly passcode: string | null;
  readonly userName: string;
  readonly zak: string;
}

/** JSON that cannot close the script element it sits in. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function callPageHtml(served?: ServedCall): string {
  const scripts = [
    ...VENDOR.map((name) => `https://source.zoom.us/${MEETING_SDK_VERSION}/lib/vendor/${name}.min.js`),
    `https://source.zoom.us/zoom-meeting-embedded-${MEETING_SDK_VERSION}.min.js`,
  ]
    .map((source) => `<script src="${source}"></script>`)
    .join("\n");
  const call =
    served === undefined
      ? ""
      : `<script>window.__ZOOM_CALL__ = ${inlineJson({
          signature: served.signature,
          meetingNumber: served.meetingNumber,
          passcode: served.passcode,
          userName: served.userName,
          zak: served.zak,
        })};</script>\n`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Zoom</title>
<style>${THEME_CSS}</style>
</head>
<body>
<div id="notice" role="status"></div>
<div id="meetingSDKElement"></div>
<script>${MEDIA_REPORT_SCRIPT}</script>
${scripts}
${call}<script>${CALL_PAGE_SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The page the browser lands on after Zoom's consent screen. */
export function resultPageHtml(ok: boolean, message: string): string {
  const hint = ok ? "Эту вкладку можно закрыть и вернуться в BB." : "Вернитесь в BB и начните подключение заново.";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Makosh Zoom</title>
<style>body { font: 16px/1.5 system-ui, sans-serif; margin: 15vh auto; max-width: 28rem; padding: 0 1.5rem; } h1 { font-size: 1.25rem; }</style>
</head>
<body>
<h1>${escapeHtml(message)}</h1>
<p>${hint}</p>
</body>
</html>
`;
}
