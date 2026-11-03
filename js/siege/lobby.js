// Wonder Wars custom games: a lobby with six places (up to three a team). The creator
// fills each place with the computer (its own difficulty, civ and colour),
// leaves it open for someone on the same Wi-Fi to join, or closes it.
//
// Creating a game works anywhere; in the Android app it's also advertised on
// the Wi-Fi so others see it in their Join list (no IP to type). With nobody
// joined, the game runs on this phone alone.

import { loadTree, civIconUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { getLan, onlineLan, BothLan } from './net.js';
import { WEB_URL } from './online-config.js';
import qrcode from '../vendor/qrcode.js';
import { buildKit } from './kit.js';
import { loadAssets, openGame, COLOURS, LEVELS } from './ui.js';

const VERSION = 1;   // bump when the network messages change, so mismatched app versions don't play together
// Up to 3v3
const SLOT_TEAM = [0, 0, 0, 1, 1, 1];
const SLOT_NAMES = ['Blue 1', 'Blue 2', 'Blue 3', 'Red 1', 'Red 2', 'Red 3'];
const DICE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="4" y="4" width="32" height="32" rx="7" fill="#8a7a5c"/><g fill="#fff"><circle cx="13" cy="13" r="3.2"/><circle cx="27" cy="13" r="3.2"/><circle cx="20" cy="20" r="3.2"/><circle cx="13" cy="27" r="3.2"/><circle cx="27" cy="27" r="3.2"/></g></svg>')}`;
const filled = (s) => s.kind === 'human' || s.kind === 'ai';

const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('aria-') || k.startsWith('data-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/** action: 'create' or 'join'. name: this player's name. */
export function openLobby({ data, strings, action, name, code: startCode = null }) {
  const wifi = getLan();   // the Wi-Fi (Android app), or a development relay
  let lan = wifi;          // hosting: the Wi-Fi and online together
  const civs = civOptions(data, strings);
  const civChoices = [{ value: 'random', label: 'Random', icon: DICE }, ...civs];
  const civName = (c) => (c === 'random' ? 'Random' : nameText(strings[data.civs[c]?.name_string_id] || c));
  const box = el('section', { className: 'sg-lobby' });
  const screen = el('div', { className: 'sg-lobby-wrap', role: 'dialog', 'aria-label': 'Custom game' }, box);
  document.body.append(screen);
  document.body.classList.add('sg-open');
  const cleanups = [];
  const close = () => {
    for (const c of cleanups.splice(0)) c();
    screen.remove();
    document.body.classList.remove('sg-open');
  };
  const show = (...kids) => box.replaceChildren(...kids.flat().filter(Boolean));
  /** The address an iPhone (or any browser) on this Wi-Fi opens to join, served by this phone. */
  const joinLink = (web) => `${web}?relay=${encodeURIComponent(`${web.replace(/^http/, 'ws')}ws`)}&sprites=${encodeURIComponent(`${web}sprites/`)}`;
  /** A QR code (as an SVG) for a link. */
  const qrSvg = (text) => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    return el('img', { className: 'sg-qr', src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: 'QR code for the join link' });
  };
  let qrShown = false;
  const iphoneBox = (link, why) => {
    if (!link) {
      return el('div', { className: 'sg-iphone' }, el('b', { textContent: '📱 iPhone friends can\'t join this time' }), el('p', { className: 'sg-note', textContent: why }));
    }
    const box = el('details', { className: 'sg-iphone', open: qrShown, ontoggle: () => { qrShown = box.open; } },
      el('summary', { className: 'sg-iphone-btn', textContent: '📱 Show the QR code for iPhone friends' }),
      el('p', { className: 'sg-note', textContent: 'On the same Wi-Fi, point the camera at this code (or open the link in Safari). The game loads from this phone; then tap Join a game.' }),
      qrSvg(link),
      el('div', { className: 'sg-iphone-link' },
        el('code', { textContent: link.split('?')[0] }),
        el('button', { type: 'button', className: 'sg-btn', textContent: 'Copy link', onclick: (e) => { navigator.clipboard?.writeText(link).then(() => { e.target.textContent = 'Copied'; }, () => {}); } }),
        navigator.share ? el('button', { type: 'button', className: 'sg-btn', textContent: 'Share', onclick: () => navigator.share({ title: 'Join my Wonder Wars game', url: link }).catch(() => {}) }) : null));
    return box;
  };

  /** The room code for friends who aren't on this Wi-Fi, with a link and QR code to send them. */
  const onlineBox = (code, why) => {
    if (!code) {
      return why ? el('div', { className: 'sg-iphone' }, el('b', { textContent: '🌐 Online joining isn\'t working right now' }), el('p', { className: 'sg-note', textContent: why })) : null;
    }
    const link = `${WEB_URL}?join=${code}`;
    return el('div', { className: 'sg-online' },
      el('div', { className: 'sg-online-head' }, el('span', { textContent: '🌐 Online code' }), el('b', { className: 'sg-code', textContent: code })),
      el('p', { className: 'sg-note', textContent: `Friends anywhere (any Wi-Fi or mobile data): in the app, tap Join a game and type ${code}. On an iPhone, open the link or scan the code.` }),
      el('details', { className: 'sg-online-qr' }, el('summary', { textContent: 'Show the QR code' }), qrSvg(link)),
      el('div', { className: 'sg-iphone-link' },
        el('button', { type: 'button', className: 'sg-btn', textContent: 'Copy link', onclick: (e) => { navigator.clipboard?.writeText(link).then(() => { e.target.textContent = 'Copied'; }, () => {}); } }),
        navigator.share ? el('button', { type: 'button', className: 'sg-btn', textContent: 'Share', onclick: () => navigator.share({ title: 'Join my Wonder Wars game', text: `Join my Wonder Wars game: code ${code}`, url: link }).catch(() => {}) }) : null));
  };

  const head = (title) => el('div', { className: 'sg-lobby-head' },
    el('button', { type: 'button', className: 'sg-x', textContent: '‹', 'aria-label': 'Back', onclick: close }),
    el('h2', { textContent: title }));
  const civPicker = (value, onChange) => {
    const p = new Picker({ label: 'Civilisation', onChange });
    p.setOptions(civChoices, value);
    return p.button;
  };
  const swatches = (slots, i, onPick) => {
    const taken = new Set(slots.filter((s, j) => j !== i && filled(s)).map((s) => s.colour));
    return el('div', { className: 'sg-swatches' }, COLOURS.map((c) => el('button', {
      type: 'button', className: `sg-swatch${slots[i].colour === c.hex ? ' on' : ''}`, style: `background:${c.hex}`, title: c.name,
      disabled: taken.has(c.hex), 'aria-label': c.name, onclick: () => onPick(c.hex),
    })));
  };

  // ---------- Creating ----------
  async function create() {
    const gameName = `${name}'s game`;
    show(head(gameName), el('p', { className: 'status', textContent: 'Setting up…' }));
    let online = false;
    let netNote = null;
    let webLink = null;   // for iPhones on this Wi-Fi: open this in Safari to join
    let webWhy = null;    // or why there's no link
    let code = null;      // for friends anywhere: the online room code
    let codeWhy = null;   // or why there isn't one
    const remote = onlineLan();
    if (wifi || remote) {
      lan = new BothLan(wifi, remote);
      try {
        const r = await lan.host(gameName);
        online = true;
        if (wifi) {
          webLink = r?.web ? joinLink(r.web) : null;
          webWhy = r?.web ? null : r?.wifiError || r?.webError || 'This version of the app can\'t host iPhones: update it, or check you\'re on Wi-Fi.';
        }
        code = r?.code || null;
        codeWhy = remote && !code ? r?.onlineError || 'Couldn\'t reach the online server.' : null;
      } catch (err) { netNote = `Others can't join right now (${err.message}). You can still play against the computer.`; }
    } else netNote = 'Friends can join when you create the game in the Android app, on the same Wi-Fi.';

    const slots = SLOT_NAMES.map(() => ({ kind: online ? 'open' : 'closed' }));
    slots[0] = { kind: 'human', name, colour: COLOURS[0].hex, civ: store.get('sg-civ') || 'random', peer: 'host', ready: true };
    slots[3] = { kind: 'ai', colour: COLOURS[1].hex, civ: 'random', level: store.get('sg-level') || 'normal' };
    let selected = 0;
    const freeColour = () => COLOURS.find((c) => !slots.some((s) => filled(s) && s.colour === c.hex))?.hex || COLOURS[0].hex;
    const me = () => slots.findIndex((s) => s.peer === 'host');
    const sendLobby = () => { if (online) lan.broadcast(JSON.stringify({ t: 'lobby', name: gameName, slots: slots.map(({ peer, ...s }) => s) })); };
    const refresh = () => { sendLobby(); render(); };
    let stopListening = () => {};

    if (online) {
      const offMsg = lan.on('message', (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        const mine = slots.findIndex((s) => s.peer === m.peer);
        if (msg.t === 'hello') {
          if (msg.v !== VERSION) { lan.sendTo(m.peer, JSON.stringify({ t: 'refused', why: 'Different app versions: update the app on both phones.' })); return; }
          // An open place, on the team with fewer players first
          const count = (t) => slots.filter((s, i) => SLOT_TEAM[i] === t && filled(s)).length;
          const free = [1, 4, 2, 5, 3, 0].sort((a, b) => count(SLOT_TEAM[a]) - count(SLOT_TEAM[b])).find((i) => slots[i].kind === 'open');
          if (free === undefined) { lan.sendTo(m.peer, JSON.stringify({ t: 'refused', why: 'That game has no open places.' })); return; }
          slots[free] = { kind: 'human', name: String(msg.name || 'Player').slice(0, 16), colour: freeColour(), civ: 'random', peer: m.peer, ready: false };
          lan.sendTo(m.peer, JSON.stringify({ t: 'welcome', slot: free }));
          refresh();
        } else if (mine >= 0 && msg.t === 'set') {
          const s = slots[mine];
          if (msg.colour && !slots.some((o, i) => i !== mine && filled(o) && o.colour === msg.colour)) s.colour = msg.colour;
          if (msg.civ && (msg.civ === 'random' || data.civs[msg.civ])) s.civ = msg.civ;
          if (msg.slot !== undefined && slots[msg.slot]?.kind === 'open') {
            slots[msg.slot] = s; slots[mine] = { kind: 'open' };
            if (selected === mine) selected = msg.slot;
            lan.sendTo(m.peer, JSON.stringify({ t: 'welcome', slot: msg.slot }));
          }
          refresh();
        } else if (mine >= 0 && msg.t === 'ready') {
          slots[mine].ready = Boolean(msg.on);
          refresh();
        }
      });
      const offPeer = lan.on('peer', (e) => {
        if (e.state !== 'leave') return;
        const i = slots.findIndex((s) => s.peer === e.peer);
        if (i >= 0) { slots[i] = { kind: 'open' }; refresh(); }
      });
      stopListening = () => { offMsg(); offPeer(); };
      cleanups.push(() => { stopListening(); lan.stopHost(); });
    }

    // What the creator can change about the selected place
    function editor(i) {
      const s = slots[i];
      const where = SLOT_NAMES[i];
      const set = (patch) => { Object.assign(slots[i], patch); refresh(); };
      if (s.peer === 'host') {
        return el('div', { className: 'sg-mine' },
          el('h3', { textContent: `You · ${where}` }),
          el('div', { className: 'field' }, el('span', { textContent: 'Your civilisation' }), civPicker(s.civ, (c) => { store.set('sg-civ', c); set({ civ: c }); })),
          el('div', { className: 'field' }, el('span', { textContent: 'Your colour' }), swatches(slots, i, (hex) => set({ colour: hex }))));
      }
      if (s.kind === 'ai') {
        return el('div', { className: 'sg-mine' },
          el('h3', { textContent: `Computer · ${where}` }),
          el('div', { className: 'field' }, el('span', { textContent: 'Difficulty' }),
            el('div', { className: 'sg-levels' }, Object.entries(LEVELS).map(([k, v]) => el('button', {
              type: 'button', textContent: v.label, 'aria-pressed': String(s.level === k), onclick: () => set({ level: k }),
            })))),
          el('div', { className: 'field' }, el('span', { textContent: 'Civilisation' }), civPicker(s.civ, (c) => set({ civ: c }))),
          el('div', { className: 'field' }, el('span', { textContent: 'Colour' }), swatches(slots, i, (hex) => set({ colour: hex }))),
          el('div', { className: 'sg-slot-acts' },
            online ? el('button', { type: 'button', className: 'sg-btn', textContent: 'Open for a friend', onclick: () => { slots[i] = { kind: 'open' }; refresh(); } }) : null,
            el('button', { type: 'button', className: 'sg-btn', textContent: 'Remove', onclick: () => { slots[i] = { kind: 'closed' }; refresh(); } })));
      }
      if (s.kind === 'human') {
        return el('div', { className: 'sg-mine' },
          el('h3', { textContent: `${s.name} · ${where}` }),
          el('p', { className: 'sg-note', textContent: `${s.name} joined from their phone and picks their own civ and colour.` }),
          el('div', { className: 'sg-slot-acts' }, el('button', { type: 'button', className: 'sg-btn', textContent: `Remove ${s.name}`, onclick: () => {
            lan.sendTo(s.peer, JSON.stringify({ t: 'refused', why: 'The host removed you from the game.' }));
            lan.kick(s.peer);
            slots[i] = { kind: 'open' }; refresh();
          } })));
      }
      // Open or closed
      return el('div', { className: 'sg-mine' },
        el('h3', { textContent: `${where}: ${s.kind === 'open' ? 'open' : 'empty'}` }),
        el('p', { className: 'sg-note', textContent: s.kind === 'open' ? 'Anyone who joins your game takes an open place.' : 'Nobody plays here.' }),
        el('div', { className: 'sg-slot-acts' },
          el('button', { type: 'button', className: 'fight', textContent: 'Add the computer', onclick: () => {
            slots[i] = { kind: 'ai', colour: freeColour(), civ: 'random', level: store.get('sg-level') || 'normal' }; refresh();
          } }),
          online ? el('button', { type: 'button', className: 'sg-btn', textContent: s.kind === 'open' ? 'Close (no joining)' : 'Open for a friend', onclick: () => { slots[i] = { kind: s.kind === 'open' ? 'closed' : 'open' }; refresh(); } }) : null,
          el('button', { type: 'button', className: 'sg-btn', textContent: 'Move me here', onclick: () => {
            const from = me(); slots[i] = slots[from]; slots[from] = { kind: online ? 'open' : 'closed' }; selected = i; refresh();
          } })));
    }

    function render() {
      if (!slots[selected]) selected = me();
      const humansReady = slots.every((s) => s.kind !== 'human' || s.ready);
      const teamsOk = [0, 1].every((t) => slots.some((s, i) => SLOT_TEAM[i] === t && filled(s)));
      const waiting = slots.some((s) => s.kind === 'open');
      show(head(gameName),
        el('p', { className: 'sg-note', textContent: online ? 'Tap a place to set it up: the computer, open for a friend to join, or empty.' : 'Tap a place to add the computer or change it.' }),
        netNote ? el('p', { className: 'sg-note', textContent: netNote }) : null,
        online ? onlineBox(code, codeWhy) : null,
        online && wifi ? iphoneBox(webLink, webWhy) : null,
        slotGrid(slots, { me: me(), selected, online, onTap: (i) => { selected = i; render(); } }),
        editor(selected),
        !teamsOk ? el('p', { className: 'sg-note sg-warn', textContent: 'Each team needs at least one player or computer.' }) : null,
        !humansReady ? el('p', { className: 'sg-note', textContent: 'Waiting for everyone who joined to tick Ready…' }) : null,
        teamsOk && humansReady && waiting ? el('p', { className: 'sg-note', textContent: 'Open places nobody has joined are left empty when you start.' }) : null,
        el('div', { className: 'sg-lobby-acts' }, el('button', { type: 'button', className: 'fight', textContent: 'Start', disabled: !humansReady || !teamsOk, onclick: () => begin() })));
    }

    async function begin() {
      const keys = Object.keys(data.civs);
      const list = slots.map((s, i) => ({ s, i })).filter(({ s }) => filled(s));
      const players = list.map(({ s, i }) => {
        const civ = s.civ === 'random' ? keys[Math.floor(Math.random() * keys.length)] : s.civ;
        const pname = s.kind === 'ai' ? `${civName(civ)} (${LEVELS[s.level].label})` : s.name;
        return { name: pname, civ, civName: civName(civ), colour: s.colour, team: SLOT_TEAM[i], kind: s.kind, level: s.level, peer: s.peer };
      });
      const seed = Math.floor(Math.random() * 1e9);
      const shared = players.map(({ peer, ...p }) => p);
      const guests = players.some((p) => p.kind === 'human' && p.peer !== 'host');
      stopListening();
      cleanups.length = 0;
      const myIndex = players.findIndex((p) => p.peer === 'host');
      if (!guests) {
        if (online) lan.stopHost();
        await launch(shared, myIndex, 'solo', seed, null);
        return;
      }
      lan.stopAdvertising();
      players.forEach((p, i) => { if (p.kind === 'human' && p.peer !== 'host') lan.sendTo(p.peer, JSON.stringify({ t: 'start', players: shared, me: i, seed })); });
      const peers = new Map(players.map((p, i) => [i, p.peer]).filter(([, peer]) => peer && peer !== 'host'));
      await launch(shared, myIndex, 'host', seed, { lan, peers, onLeave: () => lan.stopHost() });
    }
    render();
  }

  // ---------- Joining ----------
  function join(errorText = null, prefill = '') {
    // Online: type the host's code
    const codeIn = el('input', { type: 'text', className: 'sg-code-in', maxLength: 4, placeholder: 'CODE', value: prefill, autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, enterKeyHint: 'go' });
    codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    let stopWifi = () => {};
    const byCode = () => {
      const c = codeIn.value.trim().toUpperCase();
      if (c.length !== 4) { codeIn.focus(); codeIn.classList.add('need'); return; }
      stopWifi();
      connect({ name: `Game ${c}`, code: c }, onlineLan());
    };
    const codeBox = onlineLan() ? el('form', { className: 'sg-join-code', onsubmit: (e) => { e.preventDefault(); byCode(); } },
      el('b', { textContent: '🌐 Join with a code' }),
      el('p', { className: 'sg-note', textContent: 'From anywhere: type the code shown in the host\'s game.' }),
      el('div', { className: 'sg-code-row' }, codeIn, el('button', { type: 'submit', className: 'fight', textContent: 'Join' }))) : null;
    const errorNote = errorText ? el('p', { className: 'status error', textContent: errorText }) : null;
    if (!wifi) {
      show(head('Join a game'), errorNote, codeBox,
        el('p', { className: 'sg-note', textContent: codeBox ? 'Games on the same Wi-Fi show up here in the Android app.' : 'Joining works in the Android app: everyone on the same Wi-Fi opens Wonder Wars, one creates a game, the others join it.' }));
      return;
    }
    const lan = wifi;
    const games = new Map();
    const list = el('div', { className: 'sg-games' });
    const draw = () => list.replaceChildren(...(games.size ? [...games.values()].map((g) => el('button', {
      type: 'button', className: 'sg-game', onclick: () => { stop(); connect(g); },
    }, el('b', { textContent: g.name }), el('small', { textContent: 'Tap to join' }))) : [el('p', { className: 'sg-note sg-searching', textContent: 'Looking for games on this Wi-Fi…' })]));
    const offFound = lan.on('found', (g) => { games.set(g.id, g); draw(); });
    const offLost = lan.on('lost', (g) => { games.delete(g.id); draw(); });
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; offFound(); offLost(); lan.stopDiscover(); };
    stopWifi = stop;
    cleanups.push(stop);
    lan.discover().catch((err) => list.replaceChildren(el('p', { className: 'status error', textContent: err.message })));
    show(head('Join a game'), errorNote, codeBox, codeBox ? el('b', { className: 'sg-wifi-h', textContent: '📶 Games on this Wi-Fi' }) : null, list,
      el('p', { className: 'sg-note', textContent: 'Games created on this Wi-Fi show up here. If nothing appears, check you\'re on the same network as the host.' }));
    draw();
  }

  /** Joins a game: one found on the Wi-Fi, or by its online code (via: that connection). */
  async function connect(game, via = wifi) {
      const lan = via;
      show(head(game.name), el('p', { className: 'status', textContent: 'Joining…' }));
      try { await lan.join(game); } catch (err) {
        if (game.code) { lan.leave(); join(err.message, game.code); } else show(head('Join a game'), el('p', { className: 'status error', textContent: err.message }));
        return;
      }
      let slots = null;
      let mySlot = null;
      let civ = data.civs[store.get('sg-civ')] ? store.get('sg-civ') : 'random';
      const offMsg = lan.on('message', async (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.t === 'welcome') { mySlot = msg.slot; render(); }
        else if (msg.t === 'lobby') { slots = msg.slots; render(); }
        else if (msg.t === 'refused') { offMsg(); offClosed(); lan.leave(); show(head('Join a game'), el('p', { className: 'status error', textContent: msg.why })); }
        else if (msg.t === 'start') {
          offMsg(); offClosed(); cleanups.length = 0;
          await launch(msg.players, msg.me, 'client', msg.seed, { lan, onLeave: () => lan.leave() });
        }
      });
      const offClosed = lan.on('closed', () => { offMsg(); offClosed(); show(head('Join a game'), el('p', { className: 'status error', textContent: 'The host closed the game.' })); });
      cleanups.push(() => { offMsg(); offClosed(); lan.leave(); });
      lan.send(JSON.stringify({ t: 'hello', v: VERSION, name }));
      if (civ !== 'random') lan.send(JSON.stringify({ t: 'set', civ }));

      function render() {
        if (!slots || mySlot === null) return;
        const ready = slots[mySlot]?.ready;
        show(head(game.name),
          slotGrid(slots, { me: mySlot, selected: mySlot, online: true, onTap: (i) => { if (slots[i].kind === 'open') lan.send(JSON.stringify({ t: 'set', slot: i })); } }),
          el('div', { className: 'sg-mine' },
            el('div', { className: 'field' }, el('span', { textContent: 'Your civilisation' }), civPicker(civ, (c) => { civ = c; store.set('sg-civ', c); lan.send(JSON.stringify({ t: 'set', civ: c })); })),
            el('div', { className: 'field' }, el('span', { textContent: 'Your colour' }), swatches(slots, mySlot, (hex) => lan.send(JSON.stringify({ t: 'set', colour: hex })))),
            el('p', { className: 'sg-note', textContent: 'Tap an open place to move there.' })),
          el('div', { className: 'sg-lobby-acts' },
            el('button', { type: 'button', className: ready ? 'sg-btn sg-big' : 'fight', textContent: ready ? 'Not ready' : 'Ready',
              onclick: () => lan.send(JSON.stringify({ t: 'ready', on: !ready })) })),
          el('p', { className: 'sg-note', textContent: ready ? 'Waiting for the host to start…' : 'Pick your civ and colour, then tick Ready.' }));
      }
  }

  // ---------- The six places ----------
  function slotGrid(slots, { me, selected, online, onTap }) {
    const card = (s, i) => {
      const cls = `sg-slot${i === me ? ' me' : ''}${i === selected ? ' sel' : ''}${filled(s) ? '' : ` ${s.kind}`}`;
      const kids = [el('small', { textContent: SLOT_NAMES[i] })];
      if (s.kind === 'open') kids.push(el('b', { textContent: 'Open' }), el('span', { className: 'sg-slot-hint', textContent: 'Waiting for someone to join' }));
      else if (s.kind === 'closed') kids.push(el('b', { textContent: 'Empty' }), el('span', { className: 'sg-slot-hint', textContent: online ? 'Tap to add the computer or open it' : 'Tap to add the computer' }));
      else {
        kids.push(
          el('b', { textContent: s.kind === 'ai' ? 'Computer' : `${s.name}${i === me ? ' (you)' : ''}` }),
          el('span', { className: 'sg-slot-civ' }, s.civ !== 'random' && data.civs[s.civ] ? el('img', { src: civIconUrl(s.civ), alt: '' }) : null, civName(s.civ)),
          s.kind === 'ai' ? el('span', { className: 'sg-slot-hint', textContent: LEVELS[s.level]?.label || '' })
            : el('span', { className: `sg-ready${s.ready ? ' on' : ''}`, textContent: s.ready ? 'Ready' : 'Not ready' }));
      }
      return el('button', { type: 'button', className: cls, style: filled(s) ? `--pc:${s.colour}` : '', onclick: () => onTap(i) }, kids);
    };
    return el('div', { className: 'sg-slots' },
      el('div', { className: 'sg-team blue' }, el('h4', { textContent: 'Blue team' }), [0, 1, 2].map((i) => card(slots[i], i))),
      el('div', { className: 'sg-team red' }, el('h4', { textContent: 'Red team' }), [3, 4, 5].map((i) => card(slots[i], i))));
  }

  // ---------- Into the game ----------
  async function launch(players, me, mode, seed, net) {
    const status = el('p', { className: 'status', textContent: 'Getting the armies ready…' });
    show(status);
    try {
      const kits = await Promise.all(players.map(async (p) => buildKit({ data, strings, tree: await loadTree(p.civ), civ: p.civ })));
      const assets = await loadAssets(kits, (msg) => { status.textContent = msg; });
      close();
      openGame({ data, kits, assets, players, me, mode, seed, net });
    } catch (err) {
      console.error(err);
      show(head('Custom game'), el('p', { className: 'status error', textContent: `Couldn't start: ${err.message}` }));
    }
  }

  // Opened from a friend's link (?join=CODE): straight into their game
  if (action === 'join' && startCode && onlineLan()) connect({ name: `Game ${startCode}`, code: startCode }, onlineLan());
  else if (action === 'join') join(); else create();
}
