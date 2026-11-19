"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString("hex");

/* ---------- storage: Postgres on Render, a local file for testing ---------- */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg"), u = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: u, max: 4, ssl: /render\.com|sslmode=require/.test(u) || process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined });
}
const FILE = path.join(__dirname, "data.json");
async function load() {
  if (pool) {
    await pool.query("create table if not exists app_state(id int primary key, data jsonb not null, updated_at timestamptz default now())");
    const r = await pool.query("select data from app_state where id=1");
    return r.rows[0] ? r.rows[0].data : null;
  }
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { return null; }
}
async function store(d) {
  if (pool) await pool.query("insert into app_state(id,data) values(1,$1) on conflict(id) do update set data=$1, updated_at=now()", [JSON.stringify(d)]);
  else fs.writeFileSync(FILE, JSON.stringify(d));
}
let ST = null, chain = Promise.resolve();
const persist = () => (chain = chain.then(() => store(ST)).catch(e => console.error("save failed", e.message)));

/* ---------- helpers ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const b64 = b => Buffer.from(b).toString("base64url");
const mac = p => crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
const sign = (o, ttl) => { const p = b64(JSON.stringify({ ...o, exp: Date.now() + ttl })); return p + "." + mac(p); };
const verify = t => {
  try {
    const [p, s] = String(t).split("."), h = mac(p);
    if (!s || s.length !== h.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(h))) return null;
    const o = JSON.parse(Buffer.from(p, "base64url")); return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
};
const hash = k => { const s = crypto.randomBytes(8).toString("hex"); return "s$" + s + "$" + crypto.scryptSync(String(k), s, 32).toString("hex"); };
const check = (k, h) => {
  const a = String(h || "").split("$"); if (a[0] !== "s" || a.length !== 3) return false;
  const x = crypto.scryptSync(String(k), a[1], 32), y = Buffer.from(a[2], "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const hits = new Map();
const limited = (k, max, ms) => { const n = Date.now(), h = hits.get(k); if (!h || h.r < n) { hits.set(k, { c: 1, r: n + ms }); return false; } return ++h.c > max; };
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.r < n) hits.delete(k); }, 60000).unref();
const fail = (c, m) => Object.assign(new Error(m), { status: c });
const send = (res, c, o) => { res.writeHead(c, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(o)); };
const rawBody = (req, max) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on("data", d => { n += d.length; if (n > max) { no(fail(413, "Too large")); req.destroy(); } else c.push(d); });
  req.on("end", () => ok(Buffer.concat(c)));
  req.on("error", no);
});
const body = async (req, max) => { const b = await rawBody(req, max); try { return b.length ? JSON.parse(b) : {}; } catch (e) { throw fail(400, "Bad request"); } };
const sid = () => ++ST._sid;
const md = b => "2000-" + String(b).slice(5, 10);

/* ---------- views ---------- */
const OWN = ["visits", "gifts", "books", "prayers", "members"];
const PRIV = ["members", "visits", "gifts", "books", "prayers", "att", "fin", "auto", "pin", "_sid", "wlog", "wsent", "optout", "lastRun"];
const bdaysAll = () => [...ST.members.filter(m => m.b).map(m => ({ n: m.n, b: md(m.b) })), ...(ST.bdays || []).map(x => ({ n: x.n, b: md(x.b) }))];
const pubView = () => {
  const o = {}; for (const k in ST) if (!PRIV.includes(k)) o[k] = ST[k];
  o.slots = (ST.slots || []).filter(s => !s.taken); o.bdays = ST.pub ? bdaysAll() : [];
  return o;
};
const adminView = () => { const o = { ...ST }; ["pin", "wlog", "wsent", "optout", "lastRun"].forEach(k => delete o[k]); return o; };
const safeM = m => { const o = { ...m }; delete o.k; return o; };
const memberPack = m => ({
  token: sign({ r: "member", p: m.p }, 24 * 3600e3), member: safeM(m),
  gifts: ST.gifts.filter(g => g.m === m.p), books: ST.books.filter(b => b.p === m.p || (m.wa && b.p === m.wa)), bdays: bdaysAll()
});

/* ---------- seed ---------- */
function seed() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "seed.json"), "utf8"));
  if (process.env.START_EMPTY === "true") ["members", "att", "fin", "visits", "gifts", "books", "prayers", "bdays"].forEach(k => d[k] = []);
  d._sid = 1000; return d;
}
function normalize() {
  OWN.concat(["att", "fin", "bdays", "slots", "gallery", "events", "sermons", "cells", "mins", "acts", "meets"]).forEach(k => { if (!Array.isArray(ST[k])) ST[k] = []; });
  ST._sid = ST._sid || 1000; delete ST.pin; ST.wlog = ST.wlog || []; ST.wsent = ST.wsent || {}; ST.optout = ST.optout || {};
  ST.members.forEach(m => { if (m.k && !String(m.k).startsWith("s$")) m.k = hash(m.k); });
}

/* ---------- admin merge: keep visitor entries made while the pastor was editing ---------- */
function mergeAdmin(C, since) {
  const added = {};
  for (const k of OWN) {
    const cl = Array.isArray(C[k]) ? C[k] : [];
    const extra = ST[k].filter(x => (x.sid || 0) > since);
    added[k] = extra; C[k] = cl.concat(extra);
  }
  ["att", "fin", "bdays", "slots", "gallery", "events", "sermons", "cells", "mins", "acts", "meets"].forEach(k => { if (!Array.isArray(C[k])) C[k] = ST[k] || []; });
  C.members.forEach(m => { if (m.k && !String(m.k).startsWith("s$")) m.k = hash(m.k); });
  C.slots.forEach(s => { if (C.books.some(b => b.d === s.d && b.tm === s.tm && b.ty === s.ty)) s.taken = true; });
  C._sid = ST._sid; delete C.pin; C.wlog = ST.wlog || []; C.wsent = ST.wsent || {}; C.optout = ST.optout || {}; C.lastRun = ST.lastRun; ST = C;
  return added;
}

/* ---------- WhatsApp automation (WhatsApp Business Platform, template messages) ---------- */
const TZ = process.env.TIMEZONE || "Africa/Lagos", SEND_HOUR = Number(process.env.SEND_HOUR || 8);
const WA_BASE = process.env.WA_API_BASE || "https://graph.facebook.com", WA_VER = process.env.WA_API_VERSION || "v21.0", LANG = process.env.WA_LANG || "en";
const TPL = { bday: process.env.WA_TEMPLATE_BIRTHDAY || "", remind: process.env.WA_TEMPLATE_REMINDER || "", welcome: process.env.WA_TEMPLATE_WELCOME || "" };
const live = () => !!(process.env.WA_TOKEN && process.env.WA_PHONE_ID);
const nowLocal = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return { date: p.year + "-" + p.month + "-" + p.day, hour: +p.hour };
};
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], dow = d => new Date(d + "T12:00:00Z").getUTCDay();
const toIntl = n => { let d = String(n || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("0")) d = "234" + d.slice(1); else if (d.length === 10) d = "234" + d; return d.length >= 11 && d.length <= 15 ? d : ""; };
function wlog(kind, name, to, tpl, st, d) {
  ST.wlog.unshift({ sid: sid(), t: new Date().toISOString(), kind, n: name, to: "…" + String(to).slice(-4), tpl, st, d: String(d || "").slice(0, 160) });
  if (ST.wlog.length > 500) ST.wlog.length = 500;
}
async function sendTemplate(to, name, params) {
  const r = await fetch(WA_BASE + "/" + WA_VER + "/" + process.env.WA_PHONE_ID + "/messages", {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { Authorization: "Bearer " + process.env.WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name, language: { code: LANG }, components: [{ type: "body", parameters: params.map(t => ({ type: "text", text: String(t).replace(/\s+/g, " ").trim().slice(0, 100) })) }] } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
  return j;
}
let running = false;
async function runAuto() {
  if (running) return { ran: false, reason: "A run is already in progress" };
  running = true;
  const res = { ran: true, sent: 0, failed: 0, dry: 0, skipped: 0 };
  try {
    const { date } = nowLocal(), isLive = live(), auto = ST.auto || {}, first = n => String(n).split(" ")[0];
    const ok = ST.members.filter(m => m.oi && m.wa && toIntl(m.wa) && !ST.optout[toIntl(m.wa)]), jobs = [];
    const add = (kind, tpl, list) => {
      if (!list.length) return;
      if (!tpl && isLive) { wlog(kind, "(all)", "0000", "", "failed", "Template name is not set on the server"); res.failed++; return; }
      list.forEach(x => jobs.push({ kind, tpl: tpl || "(template not set)", ...x }));
    };
    if (auto.bday && auto.bday.on) add("Birthday", TPL.bday, ok.filter(m => m.b && String(m.b).slice(5, 10) === date.slice(5)).map(m => ({ key: "bday:" + m.id + ":" + date, m, params: [first(m.n), ST.name] })));
    if (auto.remind && auto.remind.on) {
      const tm = addDays(date, 1), d = dow(tm), acts = (ST.acts || []).filter(a => DOW.indexOf(String(a.day).trim().slice(0, 3).toLowerCase()) === d);
      add("Reminder", TPL.remind, acts.flatMap(a => ok.map(m => ({ key: "rem:" + m.id + ":" + a.t + ":" + tm, m, params: [first(m.n), a.t, a.tm, ST.name] }))));
    }
    if (auto.welcome && auto.welcome.on) add("Welcome", TPL.welcome, ok.filter(m => (m.jd || "") >= addDays(date, -2)).map(m => ({ key: "wel:" + m.id, m, params: [ST.name, first(m.n)] })));
    for (const j of jobs.slice(0, 300)) {
      const to = toIntl(j.m.wa);
      if (isLive && ST.wsent[j.key]) { res.skipped++; continue; }
      if (!isLive) { wlog(j.kind, j.m.n, to, j.tpl, "test", "Test mode: not sent. Set WA_TOKEN and WA_PHONE_ID to send."); res.dry++; continue; }
      try { await sendTemplate(to, j.tpl, j.params); ST.wsent[j.key] = date; wlog(j.kind, j.m.n, to, j.tpl, "sent", ""); res.sent++; }
      catch (e) { wlog(j.kind, j.m.n, to, j.tpl, "failed", e.message); res.failed++; }
      await new Promise(r => setTimeout(r, 150));
    }
    for (const k of Object.keys(ST.wsent)) if (ST.wsent[k] < addDays(date, -14)) delete ST.wsent[k];
    ST.lastRun = { date, at: new Date().toISOString(), live: isLive, sent: res.sent, failed: res.failed, dry: res.dry, skipped: res.skipped };
    await persist();
  } finally { running = false; }
  return res;
}
const due = () => { const n = nowLocal(); return n.hour >= SEND_HOUR && !(ST.lastRun && ST.lastRun.date === n.date); };
const tick = async () => { try { if (due()) await runAuto(); } catch (e) { console.error("auto run failed", e.message); } };

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const U = new URL(req.url, "http://x"), p = U.pathname, m = req.method;
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (m === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    }
    if (p === "/healthz") return send(res, 200, { ok: true });
    if (!p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
    const need = r => { const o = verify(tok); if (!o || o.r !== r) throw fail(401, "Please log in again"); return o; };
    if (m === "GET" && p === "/api/public") return send(res, 200, pubView());

    if (p === "/api/wa/webhook") {                       /* Meta calls this: verification, and STOP replies */
      const VT = process.env.WA_VERIFY_TOKEN || "", AS = process.env.WA_APP_SECRET || "";
      if (m === "GET") {
        if (VT && U.searchParams.get("hub.mode") === "subscribe" && U.searchParams.get("hub.verify_token") === VT) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(U.searchParams.get("hub.challenge") || ""); }
        throw fail(403, "Forbidden");
      }
      if (m === "POST") {
        if (!AS) throw fail(503, "WA_APP_SECRET is not set");
        const raw = await rawBody(req, 1e6), sig = String(req.headers["x-hub-signature-256"] || ""), want = "sha256=" + crypto.createHmac("sha256", AS).update(raw).digest("hex");
        if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw fail(401, "Bad signature");
        let j = {}; try { j = JSON.parse(raw); } catch (e) {}
        let changed = false;
        for (const en of j.entry || []) for (const ch of en.changes || []) for (const ms of (ch.value && ch.value.messages) || []) {
          const txt = ms.type === "text" && ms.text ? String(ms.text.body).trim().toLowerCase() : "";
          if (["stop", "unsubscribe", "stop messages", "cancel"].includes(txt)) {
            const num = String(ms.from); ST.optout[num] = today(); changed = true;
            ST.members.filter(x => toIntl(x.wa) === num).forEach(x => { x.oi = false; });
            wlog("Opt-out", "(member)", num, "", "ok", "Replied STOP");
          }
        }
        if (changed) await persist();
        return send(res, 200, { ok: true });
      }
    }
    if (p === "/api/cron/run") {                         /* an outside timer calls this every hour; it only runs once a day */
      if (limited("cr" + ip, 30, 60000)) throw fail(429, "Too many requests");
      const CR = process.env.CRON_SECRET || "";
      if (!CR || !crypto.timingSafeEqual(sha(U.searchParams.get("key") || ""), sha(CR))) throw fail(401, "Unauthorized");
      if (!due()) return send(res, 200, { ran: false, reason: "Not due yet, or already ran today" });
      return send(res, 200, await runAuto());
    }

    if (m === "POST" && p === "/api/admin/login") {
      if (!ADMIN) throw fail(503, "ADMIN_PASSWORD is not set on the server");
      if (limited("al" + ip, 8, 600000)) throw fail(429, "Too many attempts. Try again later.");
      const b = await body(req, 5e3);
      if (!crypto.timingSafeEqual(sha(b.password), sha(ADMIN))) throw fail(401, "Wrong password");
      return send(res, 200, { token: sign({ r: "admin" }, 12 * 3600e3), state: adminView(), sid: ST._sid });
    }
    if (p === "/api/admin/state") {
      need("admin");
      if (m === "GET") return send(res, 200, adminView());
      if (m === "PUT") {
        const b = await body(req, 25e6);
        if (!b.state || typeof b.state !== "object" || Array.isArray(b.state)) throw fail(400, "Bad state");
        const added = mergeAdmin(b.state, Number(b.since) || 0); await persist();
        return send(res, 200, { sid: ST._sid, added });
      }
    }
    if (p === "/api/admin/wa/status" || p === "/api/admin/wa/run") {
      need("admin");
      if (p.endsWith("status") && m === "GET") return send(res, 200, { live: live(), hour: SEND_HOUR, tz: TZ, tpl: TPL, last: ST.lastRun || null, log: ST.wlog.slice(0, 40), optouts: Object.keys(ST.optout).length });
      if (p.endsWith("run") && m === "POST") return send(res, 200, await runAuto());
    }
    if (m !== "POST") throw fail(404, "Not found");
    if (limited("w" + ip, 40, 60000)) throw fail(429, "Too many requests. Please slow down.");
    const b = await body(req, 2e5);

    if (p === "/api/lead") {
      const n = str(b.n, 80); if (!n) throw fail(400, "Please enter your name");
      ST.visits.unshift({ sid: sid(), n, p: str(b.p, 30), s: str(b.s, 80), src: str(b.src, 40) || "Other", st: "New", iso: today(), t: new Date().toLocaleDateString("en-GB") });
      await persist(); return send(res, 200, { ok: true });
    }
    if (p === "/api/book") {
      const n = str(b.n, 80), ph = str(b.p, 30), sl = b.slot || {};
      if (!n || !ph) throw fail(400, "Enter your name and phone number");
      const s = ST.slots.find(x => !x.taken && x.d === sl.d && x.tm === sl.tm && x.ty === sl.ty);
      if (!s) throw fail(409, "Sorry, that time was just taken. Please pick another.");
      s.taken = true;
      ST.books.unshift({ sid: sid(), n, p: ph, x: str(b.x, 500), d: s.d, tm: s.tm, ty: s.ty, l: s.l || "", st: "Pending" });
      await persist(); return send(res, 200, { ok: true });
    }
    if (p === "/api/gift") {
      const a = Number(b.a); if (!(a >= 100 && a <= 1e7)) throw fail(400, "Enter a valid amount");
      const ty = ["Tithe", "Offering", "Building project", "Thanksgiving", "Pledge"].includes(b.ty) ? b.ty : "Offering";
      const mo = verify(tok), mem = mo && mo.r === "member" ? ST.members.find(x => x.p === mo.p) : null;
      /* DEMO: records the gift only. Real payments need Paystack or Flutterwave and a webhook. */
      ST.gifts.unshift({ sid: sid(), n: mem ? mem.n : (str(b.n, 80) || "Anonymous"), m: mem ? mem.p : "", ty, a, iso: today(), t: new Date().toLocaleDateString("en-GB") });
      await persist(); return send(res, 200, { ok: true });
    }
    if (p === "/api/signup") {
      const n = str(b.n, 80), ph = str(b.p, 30), k = str(b.k, 60);
      if (!n || ph.length < 5 || k.length < 4) throw fail(400, "Enter your name, phone, and a PIN of 4 or more");
      if (ST.members.some(x => x.p === ph)) throw fail(409, "This phone is already registered. Sign in.");
      const wa = str(b.wa, 30), id = sid();
      const mem = { id, sid: id, n, p: ph, k: hash(k), wa, oi: !!b.oi && !!wa, b: /^\d{4}-\d{2}-\d{2}$/.test(b.b || "") ? b.b : "", cell: "", dept: "", jd: today(), t: new Date().toLocaleDateString("en-GB") };
      ST.members.push(mem); await persist(); return send(res, 200, memberPack(mem));
    }
    if (p === "/api/login") {
      const ph = str(b.p, 30);
      if (limited("ml" + ip + ph, 6, 300000)) throw fail(429, "Too many attempts. Try again in a few minutes.");
      const mem = ph.length >= 5 ? ST.members.find(x => x.p === ph) : null;
      if (!mem || !check(b.k, mem.k)) throw fail(401, "Phone or PIN is not correct");
      return send(res, 200, memberPack(mem));
    }
    if (p === "/api/member/update" || p === "/api/member/prayer") {
      const mem = ST.members.find(x => x.p === need("member").p); if (!mem) throw fail(401, "Please log in again");
      if (p.endsWith("update")) {
        if (b.wa !== undefined) mem.wa = str(b.wa, 30);
        if (b.oi !== undefined) { mem.oi = !!b.oi && !!mem.wa; if (mem.oi) delete ST.optout[toIntl(mem.wa)]; }
        if (b.cell !== undefined) mem.cell = str(b.cell, 40);
      } else {
        const x = str(b.x, 500); if (!x) throw fail(400, "Write your request first");
        ST.prayers.unshift({ sid: sid(), n: mem.n, x, t: new Date().toLocaleDateString("en-GB") });
      }
      await persist(); return send(res, 200, { ok: true });
    }
    throw fail(404, "Not found");
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : "Server error" });
  }
});

(async () => {
  ST = (await load()) || seed(); normalize(); await persist();
  server.listen(PORT, "0.0.0.0", () => console.log("Church site running on port " + PORT));
  setInterval(tick, 10 * 60 * 1000).unref(); setTimeout(tick, 30000).unref();
})();
