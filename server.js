// Servidor do Truco Paulista Online — Node.js puro, sem dependências.
// Serve o jogo (public/index.html) e roda as mesas, a fila da partida rápida
// e os bots. Comunicação: Server-Sent Events (servidor → jogador) + POST (jogador → servidor).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// ---------- motor do jogo: o mesmo código do cliente, carregado do index.html
const engineSrc = HTML.slice(HTML.indexOf('//ENGINE_START'), HTML.indexOf('//ENGINE_END'));
const sandbox = { crypto: nodeCrypto.webcrypto, setTimeout, clearTimeout, console };
vm.createContext(sandbox);
vm.runInContext(engineSrc + `
;globalThis.ENG={get G(){return G},set G(v){G=v},newGame,deal,act,addBot,scheduleBot,clearTimers,team,
 setOnChange(f){onChange=f},setAway(f){isAway=f}};`, sandbox);
const E = sandbox.ENG;

// ---------- estado
const clients = new Map(); // cid -> {cid,nm,conns:Set,table,offSince}
const tables = new Map();  // code -> {code,G,qk,againT,lastHuman}
let queue = [];            // [{cid,t,n}] em ordem de chegada (n = 2 para 1x1, 4 para 2x2)

const CID_RE = /^c[a-z0-9]{4,12}$/;
const CODE_RE = /^[a-z0-9]{4,6}$/;
const VOICE_KEYS = ['TRUCO', 'SEIS', 'NOVE', 'DOZE', 'ACEITO', 'CORRO'];
const cleanName = n => (typeof n === 'string' ? n.replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 14) : '');
function genCode() { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += a[nodeCrypto.randomInt(a.length)]; } while (tables.has(s)); return s; }
function client(cid) { let c = clients.get(cid); if (!c) { c = { cid, nm: 'Jogador', conns: new Set(), table: null, offSince: Date.now(), voices: {}, vg: 0 }; clients.set(cid, c); } return c; }
const online = cid => { const c = clients.get(cid); return !!c && c.conns.size > 0; };
function sendTo(c, obj) { const s = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const r of c.conns) { try { r.write(s); } catch (e) {} } }

function withG(tb, fn) { const prev = E.G; E.G = tb.G; try { return fn(); } finally { E.G = prev; } }

// jogador desconectado há mais de 15 s: o bot joga por ele até ele voltar
E.setAway(s => {
  const st = E.G && E.G.seats[s];
  if (!st || st.bot) return false;
  const c = clients.get(st.cid);
  return !c || (c.conns.size === 0 && Date.now() - c.offSince > 15000);
});
// chamado pelo motor depois de jogadas de bot e de timers (com E.G = a mesa certa)
E.setOnChange(() => { const g = E.G; const tb = g && tables.get(g.code); if (tb && tb.G === g) changed(tb); });

// ---------- mesas
function pubFor(tb, cid) {
  const G = tb.G;
  const seat = G.seats.findIndex(s => s && !s.bot && s.cid === cid);
  const st = {
    v: 1, code: G.code, ph: G.phase, qk: tb.qk ? 1 : 0,
    seats: G.seats.map((s, i) => s ? { n: s.n, b: s.bot ? 1 : 0, c: i === seat ? cid : '', on: (s.bot || online(s.cid)) ? 1 : 0, vz: s.bot ? 0 : voiceMap(s.cid) } : 0),
    sc: G.score, wn: G.wins, dl: G.dealer, vi: G.vira, tu: G.turn, rd: G.round,
    tb: G.table.map(p => [p.s, p.c]), pa: G.past, rs: G.rounds, va: G.value, lr: G.lastRaise,
    pd: G.pending, m11: G.m11, fe: G.ferro, sh: G.shout, res: G.res,
    hn: G.hands.map(h => h.length), hno: G.hno, win: G.win, seq: G.seq
  };
  const pv = {};
  if (seat >= 0 && G.phase !== 'wait') {
    if (G.ferro) pv.n = G.hands[seat].length; else pv.h = G.hands[seat];
    if (G.m11 && !G.m11.ok && G.seats.length === 4 && (seat & 1) === G.m11.t) pv.p = G.hands[(seat + 2) % 4];
  }
  return { t: 'st', st, pv };
}
function voiceMap(cid) { const c = clients.get(cid); if (!c) return 0; const o = {}; let any = 0; for (const k in c.voices) { o[k] = c.voices[k].v + '_' + c.vg; any = 1; } return any ? o : 0; }
function members(tb) { const out = []; for (const c of clients.values()) if (c.table === tb.code) out.push(c); return out; }
function changed(tb) {
  if (!tables.has(tb.code)) return;
  tb.G.seq++;
  withG(tb, () => E.scheduleBot());
  for (const c of members(tb)) sendTo(c, pubFor(tb, c.cid));
  // partida rápida terminada: nova partida automática
  if (tb.qk && tb.G.phase === 'over' && !tb.againT) {
    tb.againT = setTimeout(() => { tb.againT = null; if (tables.has(tb.code) && tb.G.phase === 'over') { withG(tb, () => { tb.G.score = [0, 0]; tb.G.dealer = (tb.G.dealer + 1) % tb.G.seats.length; E.deal(); }); changed(tb); } }, 12000);
  }
  lobbyDirty = true;
}
function createTable(owner, qk, n) {
  const code = genCode();
  const G = E.newGame(code, owner.cid, owner.nm, n === 2 ? 2 : 4);
  const tb = { code, G, qk: !!qk, againT: null, lastHuman: Date.now() };
  tables.set(code, tb);
  return tb;
}
function deleteTable(tb) {
  withG(tb, () => E.clearTimers());
  clearTimeout(tb.againT);
  tables.delete(tb.code);
  for (const c of members(tb)) { c.table = null; sendLobby(c); }
}
function seatOf(tb, cid) { return tb.G.seats.findIndex(s => s && !s.bot && s.cid === cid); }
function leaveTable(c) {
  const tb = c.table && tables.get(c.table);
  c.table = null;
  if (!tb) return;
  const i = seatOf(tb, c.cid);
  if (i >= 0) {
    if (tb.G.phase === 'wait') tb.G.seats[i] = 0;
    else { tb.G.seats[i] = 0; withG(tb, () => E.addBot(i)); }
  }
  if (!tb.G.seats.some(s => s && !s.bot) && !members(tb).length) deleteTable(tb);
  else changed(tb);
}
function sit(tb, c, i) {
  const G = tb.G;
  if (!(i >= 0 && i < G.seats.length)) return 'Lugar inválido';
  const cur = G.seats[i];
  if (cur && !cur.bot && cur.cid !== c.cid && online(cur.cid)) return 'Lugar ocupado';
  const mine = seatOf(tb, c.cid);
  if (mine === i) return null;
  if (mine >= 0 && G.phase !== 'wait') return 'Você já está jogando';
  if (mine >= 0) G.seats[mine] = 0;
  G.seats[i] = { cid: c.cid, n: c.nm, bot: 0 };
  return null;
}

// ---------- fila da partida rápida (ordem de chegada no servidor)
function cleanQueue() {
  queue = queue.filter(q => { const c = clients.get(q.cid); return c && !c.table && (c.conns.size > 0 || Date.now() - c.offSince < 20000); });
}
function formMatch(group, n) {
  const owner = clients.get(group[0].cid);
  const tb = createTable(owner, true, n);
  group.forEach((q, i) => { const c = clients.get(q.cid); c.table = tb.code; if (i > 0) tb.G.seats[i] = { cid: c.cid, n: c.nm, bot: 0 }; });
  withG(tb, () => { for (let i = 0; i < tb.G.seats.length; i++) if (!tb.G.seats[i]) E.addBot(i); tb.G.score = [0, 0]; E.deal(); });
  changed(tb);
}
const takeFromQueue = (n, k) => { const out = []; queue = queue.filter(q => { if (q.n === n && out.length < k) { out.push(q); return false; } return true; }); return out; };
function matchmake() {
  cleanQueue();
  for (const n of [4, 2]) {
    const waiting = () => queue.filter(q => q.n === n);
    // 1) vagas (bots) em partidas rápidas já em andamento do mesmo modo: o 1º da fila entra primeiro
    for (const tb of tables.values()) {
      if (!tb.qk || tb.G.phase === 'wait' || tb.G.seats.length !== n) continue;
      for (let i = 0; i < n && waiting().length; i++) {
        const s = tb.G.seats[i];
        if (s && s.bot) { const q = takeFromQueue(n, 1)[0]; const c = clients.get(q.cid); c.table = tb.code; tb.G.seats[i] = { cid: c.cid, n: c.nm, bot: 0 }; changed(tb); }
      }
    }
    // 2) a cada n na fila, abre uma mesa
    while (waiting().length >= n) formMatch(takeFromQueue(n, n), n);
    // 3) 2x2: 2 ou 3 esperando há mais de 1 minuto -> começa com bots
    const w = waiting();
    if (n === 4 && w.length >= 2 && Date.now() - w[0].t > 60000) formMatch(takeFromQueue(4, 4), 4);
  }
  lobbyDirty = true;
}

// ---------- lobby
let lobbyDirty = true;
function lobbyFor(c) {
  const mine = queue.find(q => q.cid === c.cid);
  const qn = mine ? mine.n : 4;
  const list = queue.filter(q => q.n === qn);
  const pos = list.findIndex(q => q.cid === c.cid);
  const now = Date.now();
  const q = list.map(x => ({ n: (clients.get(x.cid) || {}).nm || 'Jogador', w: now - x.t }));
  const q2 = queue.filter(x => x.n === 2).length, q4 = queue.filter(x => x.n === 4).length;
  const tablesList = [];
  for (const tb of tables.values()) {
    if (!tb.qk && tb.G.phase !== 'wait') continue;
    const f = tb.G.seats.filter(s => !s || s.bot).length;
    const host = tb.G.seats.find(s => s && !s.bot);
    if (tb.qk && !f) continue;
    tablesList.push({ c: tb.code, n: host ? host.n : 'Mesa', f, p: tb.G.phase, qk: tb.qk ? 1 : 0, m: tb.G.seats.length });
    if (tablesList.length >= 12) break;
  }
  let on = 0; for (const x of clients.values()) if (x.conns.size) on++;
  return { t: 'lobby', q, qn, q2, q4, pos, tables: tablesList, table: c.table || null, online: on };
}
function sendLobby(c) { sendTo(c, lobbyFor(c)); }
function lobbyBroadcast() { lobbyDirty = false; for (const c of clients.values()) if (c.conns.size && !c.table) sendLobby(c); }

// ---------- ações dos jogadores
function handle(c, a) {
  if (!a || typeof a.t !== 'string') return { err: 'Ação inválida' };
  switch (a.t) {
    case 'queue': {
      if (c.table) leaveTable(c);
      const n = a.n === 2 ? 2 : 4;
      const ex = queue.find(q => q.cid === c.cid);
      if (ex && ex.n !== n) { ex.n = n; ex.t = Date.now(); }
      if (!ex) queue.push({ cid: c.cid, t: Date.now(), n });
      matchmake(); lobbyBroadcast(); return { ok: 1 };
    }
    case 'unqueue': queue = queue.filter(q => q.cid !== c.cid); lobbyBroadcast(); return { ok: 1 };
    case 'force': {
      cleanQueue();
      const me = queue.find(q => q.cid === c.cid); if (!me) return { err: 'Você não está na fila' };
      const first = queue.find(q => q.n === me.n);
      if (first.cid !== c.cid) return { err: 'Só o 1º da fila pode começar' };
      formMatch(takeFromQueue(me.n, me.n), me.n); lobbyBroadcast(); return { ok: 1 };
    }
    case 'create': {
      queue = queue.filter(q => q.cid !== c.cid);
      if (c.table) leaveTable(c);
      const tb = createTable(c, false, a.n === 2 ? 2 : 4); c.table = tb.code; changed(tb); lobbyBroadcast(); return { ok: 1, code: tb.code };
    }
    case 'join': {
      const code = String(a.code || '').toLowerCase();
      const tb = CODE_RE.test(code) && tables.get(code);
      if (!tb) return { err: 'Mesa não encontrada. Confira o código.' };
      queue = queue.filter(q => q.cid !== c.cid);
      if (c.table && c.table !== code) leaveTable(c);
      c.table = code;
      // entra direto num lugar livre/bot, se houver
      if (seatOf(tb, c.cid) < 0) {
        const i = tb.G.seats.findIndex(s => !s || s.bot || !online(s.cid));
        if (i >= 0 && (tb.G.phase === 'wait' ? !tb.G.seats[i] : true)) sit(tb, c, i);
      }
      changed(tb); lobbyBroadcast(); return { ok: 1 };
    }
    case 'leave': queue = queue.filter(q => q.cid !== c.cid); leaveTable(c); sendLobby(c); lobbyBroadcast(); return { ok: 1 };
    case 'act': {
      const tb = c.table && tables.get(c.table);
      if (!tb) return { err: 'Você não está em uma mesa' };
      const x = a.a; if (!x || typeof x.t !== 'string') return { err: 'Ação inválida' };
      const G = tb.G; const seat = seatOf(tb, c.cid); const admin = seat >= 0;
      if (x.t === 'sit') { const e = sit(tb, c, x.s | 0); changed(tb); return e ? { err: e } : { ok: 1 }; }
      if (x.t === 'stand') { if (seat >= 0 && G.phase === 'wait') G.seats[seat] = 0; changed(tb); return { ok: 1 }; }
      if (!admin) return { err: 'Sente-se para jogar' };
      if (x.t === 'bot') { const i = x.s | 0; if (i >= 0 && i < G.seats.length && !G.seats[i]) withG(tb, () => E.addBot(i)); changed(tb); return { ok: 1 }; }
      if (x.t === 'kick') { const i = x.s | 0, s = G.seats[i]; if (!s) return { ok: 1 };
        if (s.bot && G.phase === 'wait') G.seats[i] = 0;
        else if (!s.bot && s.cid !== c.cid && !online(s.cid)) { G.seats[i] = 0; withG(tb, () => E.addBot(i)); }
        changed(tb); return { ok: 1 }; }
      if (x.t === 'fill') { withG(tb, () => { for (let i = 0; i < G.seats.length; i++) if (!G.seats[i]) E.addBot(i); }); changed(tb); return { ok: 1 }; }
      if (x.t === 'start') { if (G.phase === 'wait' && G.seats.every(Boolean)) { withG(tb, () => { G.score = [0, 0]; E.deal(); }); changed(tb); } return { ok: 1 }; }
      if (x.t === 'again') { if (G.phase === 'over') { clearTimeout(tb.againT); tb.againT = null; withG(tb, () => { G.score = [0, 0]; G.dealer = (G.dealer + 1) % G.seats.length; E.deal(); }); changed(tb); } return { ok: 1 }; }
      const ok = withG(tb, () => E.act(seat, x));
      if (ok) changed(tb); else sendTo(c, pubFor(tb, c.cid)); // desfaz a jogada mostrada antes da hora
      return ok ? { ok: 1 } : { err: '' };
    }
  }
  return { err: 'Ação desconhecida' };
}

// ---------- HTTP
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#176238"/><rect x="40" y="40" width="432" height="432" rx="70" fill="none" stroke="#e7c46a" stroke-width="10"/><g transform="translate(120 120) rotate(-12)"><rect width="170" height="250" rx="18" fill="#fffdf7"/><text x="28" y="60" font-family="Georgia" font-weight="700" font-size="56" fill="#161616">3</text><text x="85" y="185" text-anchor="middle" font-size="110" fill="#161616">♣</text></g><g transform="translate(230 150) rotate(10)"><rect width="170" height="250" rx="18" fill="#fffdf7" stroke="#ccc"/><text x="28" y="60" font-family="Georgia" font-weight="700" font-size="56" fill="#c4122f">7</text><text x="85" y="185" text-anchor="middle" font-size="110" fill="#c4122f">♥</text></g></svg>`;
const MANIFEST = JSON.stringify({
  name: 'Truco Paulista Online', short_name: 'Truco', start_url: '/', scope: '/', display: 'fullscreen',
  orientation: 'any', background_color: '#120b06', theme_color: '#120b06', lang: 'pt-BR',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
});
function readBody(req, limit = 8192) {
  return new Promise((res, rej) => { let d = ''; req.on('data', ch => { d += ch; if (d.length > limit) { rej(new Error('big')); req.destroy(); } }); req.on('end', () => res(d)); req.on('error', rej); });
}
const REDIRECT_TO = (process.env.REDIRECT_TO || '').replace(/\/$/, '');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // endereço antigo: manda todo mundo para o servidor novo (mais perto do Brasil)
  if (REDIRECT_TO && !url.pathname.startsWith('/api/')) { res.writeHead(301, { location: REDIRECT_TO + req.url, 'cache-control': 'no-cache' }); return res.end(); }
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(HTML);
    }
    if (p === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ truco: 1, online: [...clients.values()].filter(c => c.conns.size).length, mesas: tables.size })); }
    if (p === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json' }); return res.end(MANIFEST); }
    if (p === '/icon.svg' || p === '/icon.png' || p === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }); return res.end(ICON_SVG); }
    if (p === '/api/events' && req.method === 'GET') {
      const cid = url.searchParams.get('cid') || '';
      if (!CID_RE.test(cid)) { res.writeHead(400); return res.end(); }
      const c = client(cid);
      const nm = cleanName(url.searchParams.get('nm') || ''); if (nm) c.nm = nm;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      c.conns.add(res);
      const tb = c.table && tables.get(c.table);
      if (tb) { res.write('data: ' + JSON.stringify(pubFor(tb, cid)) + '\n\n'); changed(tb); }
      else { c.table = null; res.write('data: ' + JSON.stringify(lobbyFor(c)) + '\n\n'); lobbyDirty = true; }
      req.on('close', () => {
        c.conns.delete(res);
        if (!c.conns.size) { c.offSince = Date.now(); const t = c.table && tables.get(c.table); if (t) changed(t); lobbyDirty = true; }
      });
      return;
    }
    // gritos gravados pelos jogadores
    if (p === '/api/voz' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 200000) || '{}');
      const json = o => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
      if (typeof body.cid !== 'string' || !CID_RE.test(body.cid)) return json({ err: 'id' });
      const c = client(body.cid);
      let touched = false;
      if (typeof body.g === 'number') { const g = Math.max(0, Math.min(30, Math.round(body.g))); if (g !== c.vg) { c.vg = g; touched = true; } }
      const k = body.k;
      if (k !== undefined) {
        if (!VOICE_KEYS.includes(k)) return json({ err: 'grito' });
        if (body.check) return json({ have: !!(c.voices[k] && c.voices[k].v === body.v) });
        if (body.del) { delete c.voices[k]; touched = true; }
        else {
          const mime = String(body.mime || '').split(';')[0];
          if (!/^audio\/[a-z0-9.+-]{2,20}$/.test(mime) || typeof body.data !== 'string') return json({ err: 'formato' });
          const buf = Buffer.from(body.data, 'base64');
          if (buf.length < 500 || buf.length > 120000) return json({ err: 'tamanho' });
          const v = String(body.v || 'v').replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'v';
          c.voices[k] = { buf, mime, v, o: Math.max(0, Math.min(2, +body.o || 0)), n: Math.max(.2, Math.min(4, +body.n || 1)) };
          touched = true;
        }
      }
      if (touched) { const tb = c.table && tables.get(c.table); if (tb) changed(tb); }
      return json({ ok: 1 });
    }
    if (p === '/api/voz' && req.method === 'GET') {
      const tb = tables.get(url.searchParams.get('code') || '');
      const st = tb && tb.G.seats[+url.searchParams.get('s')];
      const c = st && !st.bot && clients.get(st.cid);
      const vo = c && c.voices[url.searchParams.get('k')];
      if (!vo) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': vo.mime, 'content-length': vo.buf.length, 'cache-control': 'public, max-age=86400', 'x-off': String(vo.o), 'x-norm': String(vo.n), 'x-g': String(c.vg) });
      return res.end(vo.buf);
    }
    if (p === '/api/act' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const cid = body.cid;
      if (typeof cid !== 'string' || !CID_RE.test(cid)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"err":"id inválido"}'); }
      const c = client(cid);
      const nm = cleanName(body.nm);
      if (nm && nm !== c.nm) { c.nm = nm; const tb = c.table && tables.get(c.table); if (tb) { const i = seatOf(tb, cid); if (i >= 0) tb.G.seats[i].n = nm; } }
      const out = handle(c, body.a);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Não encontrado');
  } catch (e) {
    console.error(e);
    try { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"err":"Erro no servidor"}'); } catch (x) {}
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ---------- rotinas
setInterval(() => { // batimento: mantém conexões vivas em proxies/celular
  for (const c of clients.values()) for (const r of c.conns) { try { r.write(': ping\n\n'); } catch (e) {} }
}, 20000);
setInterval(() => {
  const now = Date.now();
  matchmake();
  for (const tb of tables.values()) {
    const humans = tb.G.seats.filter(s => s && !s.bot);
    const anyOnline = humans.some(s => online(s.cid)) || members(tb).some(c => c.conns.size);
    if (anyOnline) tb.lastHuman = now;
    if (now - tb.lastHuman > 10 * 60000) { deleteTable(tb); continue; }
    if (tb.G.phase === 'play') withG(tb, () => E.scheduleBot()); // assume jogadores ausentes
  }
  for (const [cid, c] of clients) if (!c.conns.size && !c.table && now - c.offSince > 30 * 60000) clients.delete(cid);
  if (lobbyDirty) lobbyBroadcast();
}, 2000);

server.listen(PORT, () => console.log('Truco online na porta ' + PORT));
