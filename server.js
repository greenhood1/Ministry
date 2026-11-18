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
const body = (req, max) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on("data", d => { n += d.length; if (n > max) { no(fail(413, "Too large")); req.destroy(); } else c.push(d); });
  req.on("end", () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch (e) { no(fail(400, "Bad request")); } });
  req.on("error", no);
});
const sid = () => ++ST._sid;
const md = b => "2000-" + String(b).slice(5, 10);

/* ---------- views ---------- */
const OWN = ["visits", "gifts", "books", "prayers", "members"];
const PRIV = ["members", "visits", "gifts", "books", "prayers", "att", "fin", "auto", "pin", "_sid"];
const bdaysAll = () => [...ST.members.filter(m => m.b).map(m => ({ n: m.n, b: md(m.b) })), ...(ST.bdays || []).map(x => ({ n: x.n, b: md(x.b) }))];
const pubView = () => {
  const o = {}; for (const k in ST) if (!PRIV.includes(k)) o[k] = ST[k];
  o.slots = (ST.slots || []).filter(s => !s.taken); o.bdays = ST.pub ? bdaysAll() : [];
  return o;
};
const adminView = () => { const o = { ...ST }; delete o.pin; return o; };
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
  ST._sid = ST._sid || 1000; delete ST.pin;
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
  C._sid = ST._sid; delete C.pin; ST = C;
  return added;
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname, m = req.method;
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
        if (b.oi !== undefined) mem.oi = !!b.oi && !!mem.wa;
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
})();
