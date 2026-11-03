// Network transport for AOSiege Wi-Fi games.
//
// In the Android app this is the Lan plugin (LanPlugin.java): games are
// advertised and found with the phone's network service discovery, and phones
// talk over a direct connection, so nobody types an IP address.
//
// In a desktop browser (for development) a small relay server stands in for
// the network: open the app with ?relay=ws://host:port. Same events either way.
//
// Events: peer {peer, state}, message {peer?, data}, found {id, name, host, port}, lost {id}, closed.

import { RELAY } from './online-config.js';

/** True when online games (room codes) are set up in this build. */
export const onlineReady = () => Boolean(RELAY);

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= new Set()).add(fn); return () => this.handlers[ev].delete(fn); }
  emit(ev, data) { for (const fn of this.handlers[ev] || []) fn(data); }
}

class NativeLan extends Emitter {
  constructor(plugin) {
    super();
    this.p = plugin;
    for (const ev of ['peer', 'message', 'found', 'lost', 'closed']) this.p.addListener(ev, (d) => this.emit(ev, d));
  }
  host(name) { return this.p.host({ name }); }
  stopAdvertising() { return this.p.stopAdvertising(); }
  stopHost() { return this.p.stopHost(); }
  sendTo(peer, data) { return this.p.sendTo({ peer, data }); }
  broadcast(data) { return this.p.broadcast({ data }); }
  kick(peer) { return this.p.kick({ peer }); }
  discover() { return this.p.discover(); }
  stopDiscover() { return this.p.stopDiscover(); }
  join(game) { return this.p.join({ host: game.host, port: game.port }); }
  send(data) { return this.p.send({ data }); }
  leave() { return this.p.leave(); }
}

class RelayLan extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.ready = this.connect();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Relay not reachable'));
      this.ws.onclose = () => this.emit('closed', {});
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.op === 'reply') { this.pending?.(m); this.pending = null; return; }
        this.emit(m.op, m);
      };
    });
  }
  async call(msg) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.pending = (m) => (m.error ? reject(new Error(m.error)) : resolve(m));
      this.ws.send(JSON.stringify(msg));
    });
  }
  async fire(msg) { await this.ready; this.ws.send(JSON.stringify(msg)); }
  host(name) { return this.call({ op: 'host', name }); }
  stopAdvertising() { return this.fire({ op: 'stopAdvertising' }); }
  stopHost() { return this.fire({ op: 'stopHost' }); }
  sendTo(peer, data) { return this.fire({ op: 'sendTo', peer, data }); }
  broadcast(data) { return this.fire({ op: 'broadcast', data }); }
  kick(peer) { return this.fire({ op: 'kick', peer }); }
  discover() { return this.fire({ op: 'discover' }); }
  stopDiscover() { return this.fire({ op: 'stopDiscover' }); }
  join(game) { return this.call({ op: 'join', port: game.port }); }
  send(data) { return this.fire({ op: 'send', data }); }
  leave() { return this.fire({ op: 'leave' }); }
}

let lan;
/** The network, or null where Wi-Fi play isn't possible (a browser without a relay). */
export function getLan() {
  if (lan !== undefined) return lan;
  const plugin = window.Capacitor?.Plugins?.Lan;
  const relay = new URLSearchParams(location.search).get('relay');
  lan = plugin ? new NativeLan(plugin) : relay ? new RelayLan(relay) : null;
  return lan;
}

// ---------- Online games: through the relay on Cloudflare, with a room code ----------

class OnlineLan extends Emitter {
  open(path) {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(`${RELAY.replace(/\/$/, '')}/${path}`);
      this.ws = ws;
      ws.onopen = () => {
        opened = true;
        // Keep the connection alive while nothing is happening (in the lobby)
        this.ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"op":"ping"}'); }, 25000);
        resolve();
      };
      ws.onerror = () => { if (!opened) reject(new Error('Couldn\'t reach the online server: check your internet connection.')); };
      ws.onclose = () => {
        clearInterval(this.ping);
        if (this.pending) { const p = this.pending; this.pending = null; p({ error: 'Lost the connection to the online server.' }); }
        if (opened && !this.leaving) this.emit('closed', {});
      };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.op === 'reply') { const p = this.pending; this.pending = null; p?.(m); return; }
        this.emit(m.op, m);
      };
    });
  }
  call(msg) {
    return new Promise((resolve, reject) => {
      this.pending = (m) => (m.error ? reject(new Error(m.error)) : resolve(m));
      this.ws.send(JSON.stringify(msg));
    });
  }
  fire(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  /** Resolves to { code }: the room code friends type to join. */
  async host(name) { await this.open('host'); const r = await this.call({ op: 'host', name }); return { code: r.code }; }
  async join(game) { await this.open(`join/${encodeURIComponent(game.code)}`); return this.call({ op: 'join' }); }
  stopAdvertising() { this.fire({ op: 'stopAdvertising' }); }
  stopHost() { this.fire({ op: 'stopHost' }); this.leaving = true; try { this.ws?.close(); } catch { /* */ } }
  sendTo(peer, data) { this.fire({ op: 'sendTo', peer, data }); }
  broadcast(data) { this.fire({ op: 'broadcast', data }); }
  kick(peer) { this.fire({ op: 'kick', peer }); }
  discover() { return Promise.resolve(); }
  stopDiscover() {}
  send(data) { this.fire({ op: 'send', data }); }
  leave() { this.fire({ op: 'leave' }); this.leaving = true; try { this.ws?.close(); } catch { /* */ } }
}

/** A connection to an online game, to join with a code. */
export const onlineLan = () => (RELAY ? new OnlineLan() : null);

/**
 * Hosting on the Wi-Fi and online at once: friends on the Wi-Fi find the game in their
 * list, everyone else types its code. Messages go back through whichever one the
 * player came in on.
 */
export class BothLan extends Emitter {
  constructor(...parts) {
    super();
    this.parts = parts.filter(Boolean);
    this.owner = new Map();
    this.offs = [];
    for (const p of this.parts) {
      for (const ev of ['peer', 'message', 'found', 'lost', 'closed']) {
        this.offs.push(p.on(ev, (d) => { if (d?.peer) this.owner.set(d.peer, p); this.emit(ev, d); }));
      }
    }
  }
  /** { port?, web?, webError? } from the Wi-Fi, { code? , onlineError? } from online. Fails only if both do. */
  async host(name) {
    const out = {};
    let ok = false;
    let firstErr = null;
    for (const p of this.parts) {
      try { Object.assign(out, await p.host(name)); ok = true; } catch (err) {
        firstErr = firstErr || err;
        if (p instanceof OnlineLan) out.onlineError = err.message; else out.wifiError = err.message;
      }
    }
    if (!ok) throw firstErr;
    return out;
  }
  stopAdvertising() { for (const p of this.parts) p.stopAdvertising(); }
  stopHost() { for (const p of this.parts) p.stopHost(); for (const off of this.offs.splice(0)) off(); }
  sendTo(peer, data) { return this.owner.get(peer)?.sendTo(peer, data); }
  broadcast(data) { for (const p of this.parts) p.broadcast(data); }
  kick(peer) { return this.owner.get(peer)?.kick(peer); }
}
