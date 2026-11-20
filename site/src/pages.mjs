// The four pages, as plain HTML strings. Everything that is not a literal
// of this file goes through esc().
const REPO = "https://github.com/Mesteriis/bb-marketplace";
export const EFFECTIVE = "20 November 2026";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const NAV = [
  ["/", "Plugins"],
  ["/mail", "Makosh Mail"],
  ["/privacy", "Privacy policy"],
  ["/terms", "Terms"],
];

function layout({ path, title, description, body, site }) {
  const verification = site.googleVerification ? `\n<meta name="google-site-verification" content="${esc(site.googleVerification)}">` : "";
  const nav = NAV.map(([href, label]) => `<li><a href="${href}"${href === path ? ' aria-current="page"' : ""}>${label}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">${verification}
<link rel="canonical" href="${esc(site.origin)}${path === "/" ? "/" : path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<div class="shell">
<header class="top">
<a class="brand" href="/">Makosh</a>
<nav aria-label="Site"><ul class="nav">${nav}</ul></nav>
</header>
<main>
${body}
</main>
<footer class="foot">
<span>Makosh — plugins for BB</span>
<a href="/privacy">Privacy policy</a>
<a href="/terms">Terms of service</a>
<a href="${REPO}">Source code</a>
${site.contact ? `<a href="mailto:${esc(site.contact)}">${esc(site.contact)}</a>` : ""}
</footer>
</div>
</body>
</html>
`;
}

const contactLine = (site) =>
  site.contact
    ? `Write to <a href="mailto:${esc(site.contact)}">${esc(site.contact)}</a> or open an issue in the <a href="${REPO}">source repository</a>.`
    : `Open an issue in the <a href="${REPO}">source repository</a>.`;

function card(plugin) {
  return `<li><article class="card${plugin.own ? " own" : ""}"><h3>${esc(plugin.name)}</h3><p>${esc(plugin.description)}</p><p class="note">${plugin.own ? "Makosh package" : `by ${esc(plugin.author)}`} · <code>${esc(plugin.id)}</code></p></article></li>`;
}

export function homePage(site, catalog) {
  const own = catalog.plugins.filter((plugin) => plugin.own);
  const others = catalog.plugins.filter((plugin) => !plugin.own);
  return layout({
    path: "/",
    site,
    title: "Makosh — mail, messages and tasks inside BB",
    description: "Makosh is a set of open-source plugins for BB, the desktop workspace for coding agents: mail, Telegram, a task board and more, running on your own computer.",
    body: `<section class="hero">
<h1>Your mail, messages and tasks, next to your agents.</h1>
<p class="lede">Makosh is a set of open-source plugins for <a href="https://getbb.app">BB</a>, a desktop workspace for coding agents. They run on your own computer, keep their data there, and let an agent help only with what you allow.</p>
</section>
<section class="prose">
<h2>What it is</h2>
<p>BB runs coding agents in projects and threads. Makosh adds the things work arrives through: an inbox, a messenger, a task board. Each plugin is a separate package you install from this marketplace; none of them needs an account with us, and there is no Makosh server that holds your mail, messages or tasks.</p>
<ul>
<li><strong>Local first.</strong> Mail and messages are synced to a database on your computer. Sign-in tokens are kept in an encrypted local vault.</li>
<li><strong>Agents by permission.</strong> Agent access is off until you turn it on, limited to the accounts and folders you choose, and every hand-over is written to a local log you can read.</li>
<li><strong>Nothing is sent without you.</strong> An agent can propose a message; only your click sends it.</li>
</ul>
<p>The largest package is <a href="/mail">Makosh Mail</a>, which can sign in to Gmail with Google. How it uses Google data is described on its page and in the <a href="/privacy">privacy policy</a>.</p>
</section>
<section aria-labelledby="own">
<h2 id="own">Makosh packages</h2>
<ul class="grid">${own.map(card).join("")}</ul>
</section>
<section aria-labelledby="others">
<h2 id="others">The whole marketplace</h2>
<p class="measure">The marketplace also carries ${others.length} independent plugins by other authors. They are kept as forks in step with their upstream repositories, under their own names and licenses; where we changed one, the change is in its history.</p>
<ul class="grid">${others.map(card).join("")}</ul>
<p class="note tail">Install from BB: add the marketplace <code>${REPO}</code>, then pick a plugin. Source and licenses: <a href="${REPO}">${REPO.replace("https://", "")}</a>.</p>
</section>`,
  });
}

export function mailPage(site) {
  return layout({
    path: "/mail",
    site,
    title: "Makosh Mail — an email client inside BB",
    description: "Makosh Mail is a desktop email client that runs as a BB plugin: iCloud, Gmail and any IMAP account, synced to your own computer.",
    body: `<section class="hero">
<h1>Makosh Mail</h1>
<p class="lede">An email client that runs inside BB on your computer. It reads and sends mail for iCloud, Gmail and any IMAP account, and keeps a searchable copy on your own disk.</p>
</section>
<section class="prose">
<h2>What it does</h2>
<ul>
<li>Shows your mail as conversations: read, search, archive, snooze, label, move, delete.</li>
<li>Writes and sends mail: replies, forwards, drafts, attachments, send later, undo send, templates, signatures.</li>
<li>Sorts the inbox: tabs, filters, blocked senders, subscriptions, reply reminders.</li>
<li>Optional help from AI, on your click or by a switch you turn on: translate, summarize, draft a reply. It uses the AI provider you configured in BB.</li>
<li>Optional help from BB's agents, off by default: with your permission an agent can search and read the folders you chose, and propose a message for you to send.</li>
</ul>

<h2 id="google">Why it asks for access to Gmail</h2>
<p>To be a mail client for a Gmail account, Makosh Mail asks Google for these permissions when you choose "Sign in with Google":</p>
<ul>
<li><code>https://mail.google.com/</code> — read, send, move and delete your mail over IMAP and SMTP. This is the only Google permission that lets a desktop client sync a mailbox both ways; the app uses it for exactly the features listed above.</li>
<li><code>openid</code>, <code>email</code> — learn the address of the account you signed in with, to label the mailbox.</li>
</ul>
<div class="callout">
<p><strong>Where Google data goes.</strong> From Google's servers straight to the app on your computer, and nowhere else by default. The developer of Makosh Mail has no server that receives your mail, your contacts or your Google tokens, and cannot see them.</p>
</div>
<p>The sign-in token is stored in an encrypted vault on your computer. Removing the account in Makosh Mail deletes the token and the local copy of that mailbox; you can also revoke access at any time in your <a href="https://myaccount.google.com/permissions">Google Account</a>.</p>
<p>Makosh Mail's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. The details are in the <a href="/privacy">privacy policy</a>.</p>

<h2>Get it</h2>
<p>Makosh Mail is free and open source. Install BB, add the marketplace <code>${REPO}</code> and install "Makosh Mail". Questions: ${contactLine(site)}</p>
</section>`,
  });
}

export function privacyPage(site) {
  return layout({
    path: "/privacy",
    site,
    title: "Privacy policy — Makosh",
    description: "What data the Makosh plugins and this website handle, where it is kept, and how Google user data is used.",
    body: `<section class="hero">
<h1>Privacy policy</h1>
<p class="lede">Makosh plugins run on your computer and keep their data there. This page says exactly what is handled, by whom, and what never leaves your machine.</p>
<p class="note">Effective ${EFFECTIVE}. Applies to the Makosh plugins for BB (Makosh Mail and the others listed on the <a href="/">home page</a>) and to this website, makosh.sh-inc.dev.</p>
</section>
<section class="prose">
<h2>Who is responsible</h2>
<p>Makosh is developed by an individual developer (GitHub: <a href="https://github.com/Mesteriis">Mesteriis</a>). ${contactLine(site)}</p>

<h2>The short version</h2>
<ul>
<li>We do not operate a service that stores your mail, messages, contacts, tasks or sign-in tokens. They stay on your computer.</li>
<li>We do not sell data, show ads, or use your data to train AI models.</li>
<li>Data leaves your computer only to the mail and messaging services you connected, and to the AI provider you configured when you use an AI feature.</li>
<li>One optional feature involves this website: <a href="#opens">read statuses</a>. It is inactive until you set it up with your own keys, and the server then learns only that an image with a random token was fetched and when — no Google user data, no addresses, subjects, text or message identifiers.</li>
</ul>

<h2>Data the plugins handle on your computer</h2>
<ul>
<li><strong>Mail</strong> (Makosh Mail): messages, attachments, folders, labels, addresses of correspondents, drafts and your settings, in a local database inside BB's data folder.</li>
<li><strong>Sign-in secrets</strong>: passwords, app passwords and OAuth tokens, encrypted in a local vault. They are sent only to the service they belong to.</li>
<li><strong>Activity log</strong>: a local record of what agents and AI features were given (identifiers and counts, not content), kept 90 days.</li>
<li><strong>Other plugins</strong> keep their own data (messages of a messenger you connected, tasks) in the same way: locally.</li>
</ul>

<h2 id="google">Google user data</h2>
<p>If you sign in to a Gmail account in Makosh Mail, the app receives from Google:</p>
<ul>
<li>your email address (<code>openid</code>, <code>email</code>);</li>
<li>the content of your mailbox — messages, attachments, labels — and the ability to send, move and delete mail (<code>https://mail.google.com/</code>).</li>
</ul>
<p><strong>How it is used.</strong> Only to provide the mail client you see: to show, search, organize, write and send your mail. <strong>Where it is stored.</strong> On your computer, in the app's local database; the token in the encrypted local vault. <strong>Who it is shared with.</strong> Nobody, with one exception you control: when you use an AI feature (for example Translate, Summarize, or drafting a reply) the text needed for that request — subject, sender name, dates and message text, with codes, passwords and card numbers replaced — is sent to the AI provider you configured in BB, to produce the result you asked for. Automatic AI features are off until you turn them on, and you can limit AI to chosen accounts and folders or turn it off entirely.</p>
<div class="callout">
<p>Makosh Mail's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. In particular: Google user data is used only to provide and improve the user-facing features of the mail client; it is not transferred to others except as needed to provide those features at your request, to comply with law, or as part of a merger with your consent; it is not used for advertising; it is not used to train generalized AI or machine-learning models; and no human other than you reads it: the developer operates no service that receives your mail, your contacts or your Google tokens.</p>
</div>

<h2 id="opens">Read statuses (optional)</h2>
<p>If you turn on read statuses in Makosh Mail, a message you send can carry a tiny image whose address is on this website. When the recipient's mail program fetches it, this server records: a random token that identifies the sent message only to your own app, the time, and a coarse kind of client (for example "mobile" or "Gmail image proxy"). It does not store the recipient's IP address, their full browser identification, any email address, subject or text, and it sets no cookies. Records are deleted after 90 days. Your app downloads them with a secret key; nobody else can. The image is never added to signed or encrypted mail, and the feature can be turned off in Mail settings.</p>

<h2>This website</h2>
<p>The site has no accounts, cookies, analytics or third-party scripts. The web server keeps ordinary access logs (time, address requested, IP address) for a few days, at most 14, to keep the service running and safe; requests for read-status images are left out of those logs.</p>

<h2>Keeping and deleting</h2>
<p>Everything the plugins keep is in BB's data folder on your computer. Removing an account in a plugin deletes its local data and its stored secrets; uninstalling the plugin and deleting its data folder removes the rest. For a Google account you can also revoke access in your <a href="https://myaccount.google.com/permissions">Google Account</a>. To have read-status records removed before 90 days, contact us with the tokens from your app.</p>

<h2>Security</h2>
<p>Secrets are encrypted at rest with a key held by your BB installation. Connections to mail servers use TLS. Text inside email is treated as untrusted: it is never executed and never taken as an instruction by an agent. The source code is public, so these statements can be checked.</p>

<h2>Children</h2>
<p>Makosh is a tool for developers and is not directed at children under 16.</p>

<h2>Changes</h2>
<p>If this policy changes, the new text and its date appear on this page, and its history is in the public source repository.</p>
</section>`,
  });
}

export function termsPage(site) {
  return layout({
    path: "/terms",
    site,
    title: "Terms of service — Makosh",
    description: "The terms under which the Makosh plugins and this website are provided.",
    body: `<section class="hero">
<h1>Terms of service</h1>
<p class="note">Effective ${EFFECTIVE}.</p>
</section>
<section class="prose">
<h2>What you get</h2>
<p>Makosh is a set of free, open-source plugins for BB, and this website. The plugins run on your own computer. Each package is licensed under the license in its source folder; plugins by other authors keep their own licenses.</p>

<h2>Your accounts and your data</h2>
<p>You connect your own mail and messaging accounts and remain responsible for them and for what you send. You must have the right to use the accounts you connect and must follow the terms of the services behind them (for example Google's). How data is handled is described in the <a href="/privacy">privacy policy</a>.</p>

<h2>Acceptable use</h2>
<p>Do not use Makosh to send spam, to break the law, to get into accounts that are not yours, or to load this website beyond ordinary use.</p>

<h2>AI and agents</h2>
<p>Optional features can hand parts of your data to an AI provider or to agents you run in BB. You choose the provider and what it may see. Text produced by AI can be wrong; read it before you send it.</p>

<h2>No warranty</h2>
<p>The software and the website are provided "as is", without warranty of any kind. To the extent the law allows, the developer is not liable for loss of data, lost profit or other damage arising from their use. Keep your own backups; your mail remains on your mail server.</p>

<h2>Changes and contact</h2>
<p>These terms may change; the current text and its date are on this page. ${contactLine(site)}</p>
</section>`,
  });
}
