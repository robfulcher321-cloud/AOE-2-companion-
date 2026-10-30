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
