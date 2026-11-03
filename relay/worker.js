// Wonder Wars online relay (Cloudflare Worker + one Durable Object per game).
//
// Phones that aren't on the same Wi-Fi can't reach each other, so the host and the
// players who join all connect here, and messages are passed between them. It speaks
// the same messages as the Wi-Fi relay on an Android host (see js/siege/net.js):
//   host:   wss://…/host           sends {op:'host', name} -> {op:'reply', code}
//           then sendTo / broadcast / kick / stopAdvertising / stopHost
//           and receives {op:'peer', peer, state} and {op:'message', peer, data}
//   player: wss://…/join/CODE      sends {op:'join'} -> {op:'reply'} (or {error}), then send / leave
//           and receives {op:'message', data}; the socket closes when the host leaves.
// The game itself runs on the host's phone; this only forwards text.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0 or 1: easy to read out
const MAX_PLAYERS = 5;                                  // besides the host (3v3)
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHABET[b % ALPHABET.length]).join('');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Wonder Wars online relay. Open the game to play.', { headers: { 'content-type': 'text/plain' } });
    }
    const [what, code] = url.pathname.split('/').filter(Boolean);
    const room = (c) => env.ROOMS.get(env.ROOMS.idFromName(c));
    if (what === 'host') {
      // A fresh code nobody is hosting
      for (let i = 0; i < 10; i++) {
        const c = newCode();
        const res = await room(c).fetch(new Request(`https://room/host/${c}`, req));
        if (res.status !== 409) return res;
      }
      return new Response('Too busy, try again', { status: 503 });
    }
    if (what === 'join' && /^[A-Za-z0-9]{4}$/.test(code || '')) {
      const c = code.toUpperCase();
      return room(c).fetch(new Request(`https://room/join/${c}`, req));
    }
    return new Response('Not found', { status: 404 });
  },
};

export class Room {
  constructor() {
    this.host = null;
    this.peers = new Map();   // id -> socket
    this.next = 1;
    this.started = false;
    this.code = '';
  }

  async fetch(req) {
    const [, role, code] = new URL(req.url).pathname.split('/');
    if (role === 'host' && this.host) return new Response('Code in use', { status: 409 });
    this.code = code;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (role === 'host') this.hosted(server); else this.joined(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  static send(ws, msg) { try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* gone */ } }

  hosted(ws) {
    this.host = ws;
    this.started = false;
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      switch (m.op) {
        case 'host': Room.send(ws, { op: 'reply', code: this.code }); break;
        case 'sendTo': { const p = this.peers.get(m.peer); if (p) Room.send(p, { op: 'message', data: m.data }); break; }
        case 'broadcast': { const out = JSON.stringify({ op: 'message', data: m.data }); for (const p of this.peers.values()) Room.send(p, out); break; }
        case 'kick': { const p = this.peers.get(m.peer); if (p) { this.peers.delete(m.peer); try { p.close(1000, 'Removed'); } catch { /* */ } } break; }
        case 'stopAdvertising': this.started = true; break;   // the game has started: no more joining
        case 'stopHost': this.end(); break;
        default: break;   // ping
      }
    });
    const gone = () => { if (this.host === ws) this.end(); };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  /** The host has gone: everyone's connection closes (their game says the host left). */
  end() {
    const h = this.host;
    this.host = null;
    for (const p of this.peers.values()) { try { p.close(1000, 'Host left'); } catch { /* */ } }
    this.peers.clear();
    if (h) { try { h.close(1000, 'Closed'); } catch { /* */ } }
  }

  joined(ws) {
    const id = `o${this.next++}`;
    let inGame = false;
    const leave = () => {
      if (!inGame) return;
      inGame = false;
      if (this.peers.get(id) === ws) this.peers.delete(id);
      if (this.host) Room.send(this.host, { op: 'peer', peer: id, state: 'leave' });
    };
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.op === 'join') {
        const why = !this.host ? 'No game with that code: check it with the host.'
          : this.started ? 'That game has already started.'
            : this.peers.size >= MAX_PLAYERS ? 'That game is full.' : null;
        if (why) { Room.send(ws, { op: 'reply', error: why }); try { ws.close(1000, why); } catch { /* */ } return; }
        inGame = true;
        this.peers.set(id, ws);
        Room.send(ws, { op: 'reply' });
        Room.send(this.host, { op: 'peer', peer: id, state: 'join' });
      } else if (m.op === 'send' && inGame && this.host) {
        Room.send(this.host, { op: 'message', peer: id, data: m.data });
      } else if (m.op === 'leave') {
        leave();
        try { ws.close(1000, 'Left'); } catch { /* */ }
      }
    });
    ws.addEventListener('close', leave);
    ws.addEventListener('error', leave);
  }
}
