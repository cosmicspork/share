// The admin page: one document, no framework. Everything it does goes through
// same-origin fetch() calls that carry the custom client header; there are no
// HTML form posts (the CSP forbids them outright).
import type { Env } from "../env";
import { CLIENT_HEADER } from "./api";

const STYLE = `
:root { color-scheme: light dark; --line: color-mix(in srgb, CanvasText 18%, transparent); --dim: color-mix(in srgb, CanvasText 62%, transparent); }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 62rem; padding: 1.25rem 1rem 4rem; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
h1 { font-size: 1.2rem; margin: 0 0 1rem; }
h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 0 0 .6rem; }
section { margin-bottom: 1.75rem; }
.forms { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
form { border: 1px solid var(--line); border-radius: 8px; padding: .9rem; display: grid; gap: .5rem; align-content: start; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.row > * { flex: 1 1 7rem; min-width: 0; }
input, textarea, select, button { font: inherit; padding: .4rem .55rem; border: 1px solid var(--line); border-radius: 6px; background: Canvas; color: CanvasText; }
textarea { min-height: 8rem; resize: vertical; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
button { cursor: pointer; }
button.primary { background: CanvasText; color: Canvas; border-color: CanvasText; justify-self: start; }
button.danger { color: #c62828; }
label.check { display: flex; gap: .4rem; align-items: center; flex: 0 0 auto; color: var(--dim); font-size: .9rem; }
label.check input { padding: 0; }
.bar { display: flex; gap: .5rem; align-items: center; margin-bottom: .6rem; }
.bar h2 { margin: 0; flex: 1; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
th { font-weight: 600; color: var(--dim); font-size: .8rem; }
td.wide { white-space: normal; overflow-wrap: anywhere; min-width: 12rem; }
td.actions { text-align: right; }
td.actions button { padding: .15rem .5rem; font-size: .85rem; margin-left: .25rem; }
.expired { color: #c62828; }
.dim { color: var(--dim); }
#status { min-height: 1.5rem; font-size: .9rem; margin-bottom: .75rem; overflow-wrap: anywhere; }
#status.error { color: #c62828; }
`;

// Runs in the browser. Plain DOM calls and textContent only, so nothing an
// item contains (title, target, slug) is ever parsed as HTML.
function script(clientHeader: string): string {
  return `
"use strict";
const HEADERS = { "Content-Type": "application/json", ${JSON.stringify(clientHeader)}: "ui" };
const $ = (id) => document.getElementById(id);

function say(text, isError) {
  const el = $("status");
  el.textContent = text;
  el.className = isError ? "error" : "";
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: HEADERS,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error && data.error.message) || "HTTP " + res.status);
  return data;
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children || []) node.append(child);
  return node;
}

function size(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  return (n / 1048576).toFixed(1) + " MiB";
}

const day = (iso) => iso.slice(0, 10);

function row(item) {
  const link = el("a", { href: item.url, textContent: item.slug, target: "_blank", rel: "noreferrer" });
  const about = item.kind === "link" ? item.target : item.title || "";
  const detail =
    item.kind === "bundle" ? item.file_count + " files, " + size(item.size) + (item.sandbox ? "" : ", no sandbox")
    : item.kind === "paste" ? size(item.size)
    : "";
  const expires = el("td", {
    textContent: item.expires_at ? day(item.expires_at) + (item.expired ? " (expired)" : "") : "never",
    className: item.expired ? "expired" : item.expires_at ? "" : "dim",
  });
  const copy = el("button", { type: "button", textContent: "Copy URL" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      say("Copied " + item.url);
    } catch (e) {
      say("Could not copy: " + item.url, true);
    }
  });
  const del = el("button", { type: "button", textContent: "Delete", className: "danger" });
  del.addEventListener("click", async () => {
    if (!confirm("Delete " + item.slug + "? This cannot be undone.")) return;
    try {
      await api("DELETE", "/api/items/" + encodeURIComponent(item.slug));
      say("Deleted " + item.slug);
      await refresh();
    } catch (e) {
      say(e.message, true);
    }
  });
  return el("tr", {}, [
    el("td", {}, [link]),
    el("td", { textContent: item.kind }),
    el("td", { textContent: about, className: "wide" }),
    el("td", { textContent: detail, className: "dim" }),
    el("td", { textContent: day(item.updated_at) }),
    expires,
    el("td", { className: "actions" }, [copy, del]),
  ]);
}

async function refresh() {
  const kind = $("filter").value;
  const data = await api("GET", "/api/items" + (kind ? "?kind=" + kind : ""));
  const body = $("items");
  body.replaceChildren(...data.items.map(row));
  if (data.items.length === 0) {
    body.append(el("tr", {}, [el("td", { colSpan: 7, textContent: "Nothing here yet.", className: "dim" })]));
  }
}

function common(form) {
  const f = form.elements;
  const out = {};
  if (f.slug.value.trim()) out.slug = f.slug.value.trim();
  if (f.title && f.title.value.trim()) out.title = f.title.value.trim();
  if (f.expires.value.trim()) out.expires_in = f.expires.value.trim();
  if (f.replace.checked) out.replace = true;
  return out;
}

function wire(formId, path, build) {
  const form = $(formId);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const item = await api("POST", path, Object.assign(build(form.elements), common(form)));
      form.reset();
      say("Created " + item.url);
      await refresh();
    } catch (e) {
      say(e.message, true);
    }
  });
}

wire("new-link", "/api/links", (f) => ({ url: f.url.value.trim() }));
wire("new-paste", "/api/pastes", (f) => ({ content: f.content.value, content_type: f.type.value }));
$("filter").addEventListener("change", () => refresh().catch((e) => say(e.message, true)));
$("reload").addEventListener("click", () => refresh().catch((e) => say(e.message, true)));
refresh().catch((e) => say(e.message, true));
`;
}

const BODY = `
<h1>share</h1>
<div id="status" role="status"></div>

<section class="forms">
  <form id="new-link" autocomplete="off">
    <h2>New link</h2>
    <input name="url" type="url" placeholder="https://example.com/a/long/url" required>
    <div class="row">
      <input name="slug" placeholder="slug (random if empty)">
      <input name="expires" placeholder="expires, e.g. 7d">
    </div>
    <div class="row">
      <label class="check"><input name="replace" type="checkbox"> replace existing slug</label>
    </div>
    <button class="primary">Create link</button>
  </form>

  <form id="new-paste" autocomplete="off">
    <h2>New paste</h2>
    <textarea name="content" placeholder="Text or markdown" required spellcheck="false"></textarea>
    <div class="row">
      <input name="title" placeholder="title">
      <select name="type" aria-label="Type">
        <option value="text/plain">text</option>
        <option value="text/markdown">markdown</option>
      </select>
    </div>
    <div class="row">
      <input name="slug" placeholder="slug (random if empty)">
      <input name="expires" placeholder="expires, e.g. 7d">
    </div>
    <div class="row">
      <label class="check"><input name="replace" type="checkbox"> replace existing slug</label>
    </div>
    <button class="primary">Create paste</button>
  </form>
</section>

<section>
  <div class="bar">
    <h2>Items</h2>
    <select id="filter" aria-label="Filter by kind">
      <option value="">all kinds</option>
      <option value="bundle">bundles</option>
      <option value="paste">pastes</option>
      <option value="link">links</option>
    </select>
    <button id="reload" type="button">Reload</button>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th>Slug</th><th>Kind</th><th>Title / target</th><th>Content</th><th>Updated</th><th>Expires</th><th></th></tr></thead>
      <tbody id="items"></tbody>
    </table>
  </div>
</section>
`;

export function adminPage(_env: Env): Response {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>share admin</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>${BODY}<script nonce="${nonce}">${script(CLIENT_HEADER)}</script>
</body>
</html>
`;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp },
  });
}
