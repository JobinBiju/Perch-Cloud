// Perch sync: reading positions shared between a household's devices.
// There are no accounts. A "home key" (a long random string every device of one owner holds) is the only credential;
// everything is stored under a hash of it, so one home never sees another's data.
//   PUT /v1/pos/<book>   {ch, rel, len, pct, t, dev}   keep it if it is newer than what is stored
//   GET /v1/pos/<book>   the newest position, or {}
//   GET /v1/pos          every book's newest position
//   POST /v1/notes/<book>  {items: [...], dev}   merge this device's bookmarks and highlights into the stored set
//   GET /v1/notes/<book>   the stored set
// A note item is {id, k: "m" bookmark | "h" highlight, ch, rel, end (highlights), len, pct, t}, or a tombstone
// {id, del: 1, t} for one that was removed. Sets merge by id: the copy with the later t wins, a removal beating a tie.
// <book> is the book's file name on the devices. ch = chapter index, rel/len = bytes into the chapter and its length
// (devices scale by len, so differently converted copies still land on the same paragraph), t = epoch seconds.
const CORS = {"access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type"};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "cache-control": "no-store", ...CORS}});
async function homeOf(key) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const MAX_NOTES = 400, TOMB_DAYS = 180;
// one item as stored, or null when it is not a valid note or tombstone
function cleanNote(n) {
  if (!n || !int(n.id, 1, 0xFFFFFFFF) || !int(n.t, 0, 4102444800)) return null;
  if (n.del) return {id: n.id, del: 1, t: n.t};
  if ((n.k !== "m" && n.k !== "h") || !int(n.ch, 0, 4096) || !int(n.rel, 0, 1 << 30) || !int(n.len, 0, 1 << 30)) return null;
  const o = {id: n.id, k: n.k, ch: n.ch, rel: n.rel, len: n.len, pct: int(n.pct, 0, 100) ? n.pct : 0, t: n.t};
  if (n.k === "h") { if (!int(n.end, n.rel + 1, 1 << 30)) return null; o.end = n.end; }
  return o;
}
async function notes(req, env, name) {
  const stored = JSON.parse((await env.PERCH.get(name)) || "[]");
  if (req.method === "GET") return json({items: stored});
  if (req.method !== "POST") return json({error: "method"}, 405);
  let b; try { b = await req.json(); } catch (e) { return json({error: "bad json"}, 400); }
  if (!Array.isArray(b.items) || b.items.length > MAX_NOTES) return json({error: "bad items"}, 400);
  const by = new Map(stored.map(n => [n.id, n]));
  for (const raw of b.items) {
    const n = cleanNote(raw); if (!n) continue;
    const cur = by.get(n.id);
    if (!cur || n.t > cur.t || (n.t === cur.t && n.del && !cur.del)) by.set(n.id, n);
  }
  const old = Math.floor(Date.now() / 1000) - TOMB_DAYS * 86400;   // a removal is remembered long enough to reach every device
  let merged = [...by.values()].filter(n => !n.del || n.t > old).sort((a, b) => a.id - b.id);
  if (merged.length > MAX_NOTES) merged = merged.sort((a, b) => b.t - a.t).slice(0, MAX_NOTES).sort((a, b) => a.id - b.id);
  const out = JSON.stringify(merged);
  if (out !== JSON.stringify(stored)) await env.PERCH.put(name, out);   // nothing new: no write
  return json({items: merged});
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
    const url = new URL(req.url);
    const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("k") || "";
    if (key.length < 24 || key.length > 128) return json({error: "home key required"}, 401);
    const home = await homeOf(key);
    const nm = /^\/v1\/notes\/([A-Za-z0-9._-]{1,64})$/.exec(url.pathname);
    if (nm) return notes(req, env, home + ":notes:" + nm[1]);
    const m = /^\/v1\/pos(?:\/([A-Za-z0-9._-]{1,64}))?$/.exec(url.pathname);
    if (!m) return json({error: "not found"}, 404);
    const prefix = home + ":pos:";

    if (!m[1]) {   // the positions live in each key's metadata, so listing needs no further reads
      if (req.method !== "GET") return json({error: "method"}, 405);
      const out = {}; let cursor;
      do { const l = await env.PERCH.list({prefix, cursor}); for (const k of l.keys) if (k.metadata) out[k.name.slice(prefix.length)] = k.metadata; cursor = l.list_complete ? null : l.cursor; } while (cursor);
      return json(out);
    }
    const name = prefix + m[1];
    if (req.method === "GET") { const cur = await env.PERCH.getWithMetadata(name); return json(cur.metadata || {}); }
    if (req.method !== "PUT") return json({error: "method"}, 405);
    let b; try { b = await req.json(); } catch (e) { return json({error: "bad json"}, 400); }
    if (!int(b.ch, 0, 4096) || !int(b.rel, 0, 1 << 30) || !int(b.len, 0, 1 << 30) || !int(b.t, 1600000000, 4102444800)) return json({error: "bad position"}, 400);
    const pos = {ch: b.ch, rel: b.rel, len: b.len, pct: int(b.pct, 0, 100) ? b.pct : 0, t: b.t, dev: String(b.dev || "").slice(0, 32)};
    const cur = (await env.PERCH.getWithMetadata(name)).metadata;
    if (cur && cur.t >= pos.t) return json({stored: false, pos: cur});   // someone read further along in time: keep theirs
    await env.PERCH.put(name, "", {metadata: pos});
    return json({stored: true, pos});
  },
};
