// The call page: a standalone document the plugin serves and BB shows in an
// iframe on a loopback origin of its own (never BB's origin). Zoom's Meeting SDK (component view) injects a global
// stylesheet and needs React 18, so it gets a document of its own. The page
// holds no secrets: the parent posts the signature and ZAK for one meeting.
//
// Messages (all `{ type: "zoom-call:…" }`):
//   page → parent: ready | failed {message} | joined | ended | error {code, message}
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

const PAGE_SCRIPT = `
(function () {
  var parentWindow = window.parent;
  function post(message) { parentWindow.postMessage(message, "*"); }
  if (typeof ZoomMtgEmbedded === "undefined") {
    post({ type: "zoom-call:failed", message: "Не удалось загрузить Zoom Meeting SDK" });
    return;
  }
  var client = ZoomMtgEmbedded.createClient();
  var root = document.getElementById("meetingSDKElement");
  var joined = false;
  function describe(error) {
    var code = error && (error.errorCode !== undefined ? error.errorCode : error.type);
    var message = error && (error.reason || error.message);
    return { code: String(code === undefined ? "unknown" : code), message: String(message || "Zoom отклонил вход") };
  }
  client.on("connection-change", function (payload) {
    if (payload && payload.state === "Connected") { joined = true; post({ type: "zoom-call:joined" }); }
    if (payload && payload.state === "Closed") { joined = false; post({ type: "zoom-call:ended" }); }
  });
  var ready = client.init({
    zoomAppRoot: root,
    language: "ru-RU",
    patchJsMedia: true,
    customize: {
      video: {
        isResizable: false,
        popper: { disableDraggable: true },
        viewSizes: { default: { width: Math.max(320, window.innerWidth - 16), height: Math.max(240, window.innerHeight - 120) } }
      }
    }
  });
  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow || !event.data) return;
    if (event.data.type === "zoom-call:join" && event.data.call && !joined) {
      var call = event.data.call;
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
    if (event.data.type === "zoom-call:leave" && joined) {
      try { client.leaveMeeting(); } catch (error) { post({ type: "zoom-call:ended" }); }
    }
  });
  post({ type: "zoom-call:ready" });
})();
`;

export function callPageHtml(): string {
  const scripts = [
    ...VENDOR.map((name) => `https://source.zoom.us/${MEETING_SDK_VERSION}/lib/vendor/${name}.min.js`),
    `https://source.zoom.us/zoom-meeting-embedded-${MEETING_SDK_VERSION}.min.js`,
  ]
    .map((source) => `<script src="${source}"></script>`)
    .join("\n");
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Zoom</title>
<style>html, body { margin: 0; height: 100%; background: #111; } #meetingSDKElement { min-height: 100%; }</style>
</head>
<body>
<div id="meetingSDKElement"></div>
${scripts}
<script>${PAGE_SCRIPT}</script>
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
