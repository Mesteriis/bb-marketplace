import { miniAppFrameMessageMaxLength, miniAppFrameUrl } from "./mini-app.ts";

export type MiniAppMediaAccess = { camera: boolean; microphone: boolean };

const deniedFeatures = "geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'";
export const miniAppNoMediaPolicy = `camera 'none'; microphone 'none'; ${deniedFeatures}`;

const relayScript = `const app = document.querySelector("iframe");
const parentOrigin = document.body.dataset.parent;
const appOrigin = document.body.dataset.app;
const maxLength = Number(document.body.dataset.limit);
addEventListener("message", ({ source, origin, data }) => {
  if (typeof data !== "string" || data.length > maxLength) return;
  if (source === parent && origin === parentOrigin) {
    app.contentWindow.postMessage(data, appOrigin);
  } else if (source === app.contentWindow && origin === appOrigin) {
    parent.postMessage(data, parentOrigin);
  }
});`;
const relaySource = "'sha256-gOir2Rp+yiaYUsmvwqyfN3jewrYA34eAkyW9/N6YFJw='";

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function miniAppMediaFrame(source: string, parent: string, access: MiniAppMediaAccess, requireSameOrigin = false) {
  const url = miniAppFrameUrl(source);
  if (!url || (!requireSameOrigin && !access.camera && !access.microphone)) return;
  let host: URL;
  try { host = new URL(parent); } catch { return; }
  if (host.origin !== parent) return;
  const origin = new URL(url).origin;
  if (host.origin === origin) return;

  function mediaPolicy(wrapper: boolean) {
    const allowed = wrapper ? `'self' ${origin}` : origin;
    return `camera ${access.camera ? allowed : "'none'"}; microphone ${access.microphone ? allowed : "'none'"}; ${deniedFeatures}`;
  }

  // The trusted wrapper remains on the BB origin. Its policy keeps the inner
  // frame on the selected app origin, including during nested navigation.
  const csp = `default-src 'none'; base-uri 'none'; form-action 'none'; frame-src ${origin}; script-src ${relaySource}; style-src 'unsafe-inline'`;
  const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style>
<body data-parent="${escapeAttribute(host.origin)}" data-app="${origin}" data-limit="${miniAppFrameMessageMaxLength}">
<iframe title="Mini App" credentialless sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"
  allow="${mediaPolicy(false)}" src="${escapeAttribute(url)}"></iframe>
<script>${relayScript}</script>`;

  return { document, allow: mediaPolicy(true), origin: host.origin };
}
