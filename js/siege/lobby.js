// AOSiege Wi-Fi games: name, host or join, a lobby with four slots (two a team),
// then the game. Up to 4 players (2v2); empty slots can be filled with the computer.
//
// Host's phone: advertises the game on the Wi-Fi and runs it once started.
// Joining phones: list the games found on the network (no IP to type), join one,
// pick colour and civ, tick Ready.

import { loadTree, civIconUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { getLan } from './net.js';
import { buildKit } from './kit.js';
import { loadAssets, openGame, COLOURS, LEVELS } from './ui.js';

const VERSION = 1;   // bump when the network messages change, so mismatched app versions don't play together
const SLOT_TEAM = [0, 0, 1, 1];
const SLOT_NAMES = ['Blue 1', 'Blue 2', 'Red 1', 'Red 2'];
const DICE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="4" y="4" width="32" height="32" rx="7" fill="#8a7a5c"/><g fill="#fff"><circle cx="13" cy="13" r="3.2"/><circle cx="27" cy="13" r="3.2"/><circle cx="20" cy="20" r="3.2"/><circle cx="13" cy="27" r="3.2"/><circle cx="27" cy="27" r="3.2"/></g></svg>')}`;

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/** Opens the Wi-Fi game screens. ctx: { data, strings } */
export function openLanMenu({ data, strings }) {
  const lan = getLan();
  const civs = civOptions(data, strings);
  const civName = (c) => (c === 'random' ? 'Random' : nameText(strings[data.civs[c]?.name_string_id] || c));
  const box = el('section', { className: 'sg-lobby' });
  const screen = el('div', { className: 'sg-lobby-wrap', role: 'dialog', 'aria-label': 'Wi-Fi game' }, box);
  document.body.append(screen);
  document.body.classList.add('sg-open');
  const cleanups = [];
  const close = () => {
    for (const c of cleanups.splice(0)) c();
    screen.remove();
    document.body.classList.remove('sg-open');
  };
  const show = (...kids) => box.replaceChildren(...kids.flat().filter(Boolean));
  const head = (title, back) => el('div', { className: 'sg-lobby-head' },
    el('button', { type: 'button', className: 'sg-x', textContent: '‹', 'aria-label': 'Back', onclick: back }),
    el('h2', { textContent: title }));

  if (!lan) {
    show(head('Wi-Fi game', close),
      el('p', { className: 'sg-note', textContent: 'Wi-Fi games work in the Android app: everyone on the same Wi-Fi opens AOSiege, one hosts, the others join.' }));
    return;
  }

  // ---------- Name, then host or join ----------
  function menu() {
    const nameIn = el('input', { type: 'text', className: 'sg-name', maxLength: 16, value: store.get('sg-name') || '', placeholder: 'Your name', autocomplete: 'nickname' });
    const go = (fn) => () => {
      const name = nameIn.value.trim();
      if (!name) { nameIn.focus(); nameIn.classList.add('need'); return; }
      store.set('sg-name', name);
      fn(name);
    };
    show(head('Wi-Fi game', close),
      el('label', { className: 'field' }, el('span', { textContent: 'Your name' }), nameIn),
      el('div', { className: 'sg-lobby-acts' },
        el('button', { type: 'button', className: 'fight', textContent: 'Host a game', onclick: go(host) }),
        el('button', { type: 'button', className: 'sg-btn sg-big', textContent: 'Join a game', onclick: go(join) })),
      el('p', { className: 'sg-note', textContent: 'Everyone needs to be on the same Wi-Fi. Up to 4 players, 2 a team; empty places can be played by the computer.' }));
  }

  // ---------- Hosting ----------
  async function host(myName) {
    const gameName = `${myName}'s game`;
    show(head(gameName, () => { lan.stopHost(); menu(); }), el('p', { className: 'status', textContent: 'Opening the game…' }));
    try { await lan.host(gameName); } catch (err) { show(head('Wi-Fi game', menu), el('p', { className: 'status error', textContent: err.message })); return; }
    const slots = SLOT_NAMES.map(() => ({ kind: 'open' }));
    slots[0] = { kind: 'human', name: myName, colour: COLOURS[0].hex, civ: store.get('sg-civ') || 'random', peer: 'host', ready: true };
    slots[2] = { kind: 'ai', name: 'Computer', colour: COLOURS[1].hex, civ: 'random', level: 'normal' };
    const freeColour = () => COLOURS.find((c) => !slots.some((s) => s.kind !== 'open' && s.colour === c.hex))?.hex || COLOURS[0].hex;
    const sendLobby = () => lan.broadcast(JSON.stringify({ t: 'lobby', name: gameName, slots: slots.map(({ peer, ...s }) => s) }));
    const refresh = () => { sendLobby(); render(); };

    const offMsg = lan.on('message', (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      const mine = slots.findIndex((s) => s.peer === m.peer);
      if (msg.t === 'hello') {
        if (msg.v !== VERSION) { lan.sendTo(m.peer, JSON.stringify({ t: 'refused', why: 'Different app versions: update the app on both phones.' })); return; }
        // Fill the team with fewer people first
        const order = [1, 3, 2, 0].sort((a, b) => slots.filter((s, i) => SLOT_TEAM[i] === SLOT_TEAM[a] && s.kind !== 'open').length - slots.filter((s, i) => SLOT_TEAM[i] === SLOT_TEAM[b] && s.kind !== 'open').length);
        const free = order.find((i) => slots[i].kind === 'open') ?? order.find((i) => slots[i].kind === 'ai');
        if (free === undefined) { lan.sendTo(m.peer, JSON.stringify({ t: 'refused', why: 'That game is full.' })); return; }
        slots[free] = { kind: 'human', name: String(msg.name || 'Player').slice(0, 16), colour: freeColour(), civ: 'random', peer: m.peer, ready: false };
        lan.sendTo(m.peer, JSON.stringify({ t: 'welcome', slot: free }));
        refresh();
      } else if (mine >= 0 && msg.t === 'set') {
        const s = slots[mine];
        if (msg.colour && !slots.some((o, i) => i !== mine && o.kind !== 'open' && o.colour === msg.colour)) s.colour = msg.colour;
        if (msg.civ && (msg.civ === 'random' || data.civs[msg.civ])) s.civ = msg.civ;
        if (msg.slot !== undefined && slots[msg.slot]?.kind === 'open') { slots[msg.slot] = s; slots[mine] = { kind: 'open' }; lan.sendTo(m.peer, JSON.stringify({ t: 'welcome', slot: msg.slot })); }
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
    const stopListening = () => { offMsg(); offPeer(); };
    cleanups.push(() => { stopListening(); lan.stopHost(); });

    const civPick = new Picker({ label: 'Civilisation', onChange: (c) => { slots.find((s) => s.peer === 'host').civ = c; store.set('sg-civ', c); refresh(); } });
    civPick.setOptions([{ value: 'random', label: 'Random', icon: DICE }, ...civs], slots[0].civ);

    function render() {
      const me = slots.findIndex((s) => s.peer === 'host');
      const humansReady = slots.every((s) => s.kind !== 'human' || s.ready);
      const teamsOk = [0, 1].every((t) => slots.some((s, i) => SLOT_TEAM[i] === t && s.kind !== 'open'));
      const start = el('button', { type: 'button', className: 'fight', textContent: 'Start', disabled: !humansReady || !teamsOk, onclick: () => begin() });
      show(head(gameName, () => { cleanups.pop()?.(); menu(); }),
        el('p', { className: 'sg-note', textContent: 'Others on this Wi-Fi can see your game now. Tap an empty place to add the computer.' }),
        slotGrid(slots, me, {
          onSlot: (i) => {
            const s = slots[i];
            if (s.kind === 'open') slots[i] = { kind: 'ai', name: 'Computer', colour: freeColour(), civ: 'random', level: 'normal' };
            else if (s.kind === 'ai') {
              const next = { easy: 'normal', normal: 'hard', hard: null }[s.level];
              slots[i] = next ? { ...s, level: next } : { kind: 'open' };
            } else return;
            refresh();
          },
          moveTo: (i) => { if (slots[i].kind === 'open') { slots[i] = slots[me]; slots[me] = { kind: 'open' }; refresh(); } },
          colour: (hex) => { if (!slots.some((o, i) => i !== me && o.kind !== 'open' && o.colour === hex)) { slots[me].colour = hex; refresh(); } },
          civPick,
        }),
        !teamsOk ? el('p', { className: 'sg-note', textContent: 'Each team needs at least one player or computer.' }) : null,
        !humansReady ? el('p', { className: 'sg-note', textContent: 'Waiting for everyone to tick Ready…' }) : null,
        el('div', { className: 'sg-lobby-acts' }, start));
    }

    async function begin() {
      lan.stopAdvertising();
      const keys = Object.keys(data.civs);
      const list = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== 'open');
      const players = list.map(({ s, i }) => {
        const civ = s.civ === 'random' ? keys[Math.floor(Math.random() * keys.length)] : s.civ;
        return { name: s.kind === 'ai' ? `Computer (${LEVELS[s.level].label})` : s.name, civ, civName: civName(civ), colour: s.colour, team: SLOT_TEAM[i], kind: s.kind, level: s.level, peer: s.peer };
      });
      const seed = Math.floor(Math.random() * 1e9);
      const shared = players.map(({ peer, ...p }) => p);
      players.forEach((p, me) => { if (p.kind === 'human' && p.peer !== 'host') lan.sendTo(p.peer, JSON.stringify({ t: 'start', players: shared, me, seed })); });
      stopListening();
      cleanups.length = 0;
      const peers = new Map(players.map((p, i) => [i, p.peer]).filter(([, peer]) => peer && peer !== 'host'));
      await launch(shared, players.findIndex((p) => p.peer === 'host'), 'host', seed, { lan, peers, onLeave: () => lan.stopHost() });
    }
    render();
  }

  // ---------- Joining ----------
  function join(myName) {
    const games = new Map();
    const list = el('div', { className: 'sg-games' });
    const draw = () => list.replaceChildren(...(games.size ? [...games.values()].map((g) => el('button', {
      type: 'button', className: 'sg-game', onclick: () => connect(g),
    }, el('b', { textContent: g.name }), el('small', { textContent: 'Tap to join' }))) : [el('p', { className: 'sg-note sg-searching', textContent: 'Looking for games on this Wi-Fi…' })]));
    const offFound = lan.on('found', (g) => { games.set(g.id, g); draw(); });
    const offLost = lan.on('lost', (g) => { games.delete(g.id); draw(); });
    const stop = () => { offFound(); offLost(); lan.stopDiscover(); };
    cleanups.push(stop);
    lan.discover().catch((err) => list.replaceChildren(el('p', { className: 'status error', textContent: err.message })));
    show(head('Join a game', () => { cleanups.pop()?.(); menu(); }), list,
      el('p', { className: 'sg-note', textContent: 'Games hosted on this Wi-Fi show up here. If nothing appears, check you\'re on the same network as the host.' }));
    draw();

    async function connect(game) {
      stop(); cleanups.pop();
      show(head(game.name, () => { lan.leave(); menu(); }), el('p', { className: 'status', textContent: 'Joining…' }));
      try { await lan.join(game); } catch (err) { show(head('Join a game', menu), el('p', { className: 'status error', textContent: err.message })); return; }
      let slots = null;
      let mySlot = null;
      const civPick = new Picker({ label: 'Civilisation', onChange: (c) => { store.set('sg-civ', c); lan.send(JSON.stringify({ t: 'set', civ: c })); } });
      civPick.setOptions([{ value: 'random', label: 'Random', icon: DICE }, ...civs], 'random');
      const offMsg = lan.on('message', async (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.t === 'welcome') { mySlot = msg.slot; render(); }
        else if (msg.t === 'lobby') { slots = msg.slots; render(); }
        else if (msg.t === 'refused') { offMsg(); offClosed(); lan.leave(); show(head('Join a game', menu), el('p', { className: 'status error', textContent: msg.why })); }
        else if (msg.t === 'start') {
          offMsg(); offClosed(); cleanups.length = 0;
          await launch(msg.players, msg.me, 'client', msg.seed, { lan, onLeave: () => lan.leave() });
        }
      });
      const offClosed = lan.on('closed', () => { offMsg(); offClosed(); show(head('Join a game', menu), el('p', { className: 'status error', textContent: 'The host closed the game.' })); });
      cleanups.push(() => { offMsg(); offClosed(); lan.leave(); });
      lan.send(JSON.stringify({ t: 'hello', v: VERSION, name: myName }));
      const saved = store.get('sg-civ');
      if (saved && data.civs[saved]) { civPick.setOptions([{ value: 'random', label: 'Random', icon: DICE }, ...civs], saved); lan.send(JSON.stringify({ t: 'set', civ: saved })); }

      function render() {
        if (!slots || mySlot === null) return;
        const me = mySlot;
        const ready = slots[me]?.ready;
        show(head(game.name, () => { cleanups.pop()?.(); menu(); }),
          slotGrid(slots, me, {
            moveTo: (i) => lan.send(JSON.stringify({ t: 'set', slot: i })),
            colour: (hex) => lan.send(JSON.stringify({ t: 'set', colour: hex })),
            civPick,
          }),
          el('div', { className: 'sg-lobby-acts' },
            el('button', { type: 'button', className: ready ? 'sg-btn sg-big' : 'fight', textContent: ready ? 'Not ready' : 'Ready',
              onclick: () => lan.send(JSON.stringify({ t: 'ready', on: !ready })) })),
          el('p', { className: 'sg-note', textContent: ready ? 'Waiting for the host to start…' : 'Pick your colour and civ, then tick Ready.' }));
      }
    }
  }

  // ---------- The four places ----------
  function slotGrid(slots, me, { onSlot, moveTo, colour, civPick }) {
    const taken = new Set(slots.filter((s, i) => i !== me && s.kind !== 'open').map((s) => s.colour));
    const card = (s, i) => {
      const mine = i === me;
      if (s.kind === 'open') {
        return el('button', { type: 'button', className: 'sg-slot open', onclick: () => (onSlot ? onSlot(i) : moveTo(i)) },
          el('small', { textContent: SLOT_NAMES[i] }), el('b', { textContent: 'Open' }),
          el('span', { className: 'sg-slot-hint', textContent: onSlot ? 'Tap to add the computer' : 'Tap to move here' }),
          onSlot ? el('span', { className: 'sg-slot-move', textContent: 'or move here', onclick: (e) => { e.stopPropagation(); moveTo(i); } }) : null);
      }
      const civ = s.civ;
      return el(s.kind === 'ai' && onSlot ? 'button' : 'div', { type: 'button', className: `sg-slot${mine ? ' me' : ''}`, style: `--pc:${s.colour}`, onclick: s.kind === 'ai' && onSlot ? () => onSlot(i) : null },
        el('small', { textContent: SLOT_NAMES[i] }),
        el('b', { textContent: `${s.name}${mine ? ' (you)' : ''}` }),
        el('span', { className: 'sg-slot-civ' }, civ !== 'random' && data.civs[civ] ? el('img', { src: civIconUrl(civ), alt: '' }) : null, civName(civ)),
        s.kind === 'ai' ? el('span', { className: 'sg-slot-hint', textContent: `${LEVELS[s.level].label}${onSlot ? ' · tap to change' : ''}` })
          : el('span', { className: `sg-ready${s.ready ? ' on' : ''}`, textContent: s.ready ? 'Ready' : 'Not ready' }));
    };
    const mineSlot = slots[me];
    return [
      el('div', { className: 'sg-slots' },
        el('div', { className: 'sg-team blue' }, el('h4', { textContent: 'Blue team' }), card(slots[0], 0), card(slots[1], 1)),
        el('div', { className: 'sg-team red' }, el('h4', { textContent: 'Red team' }), card(slots[2], 2), card(slots[3], 3))),
      mineSlot && mineSlot.kind === 'human' ? el('div', { className: 'sg-mine' },
        el('div', { className: 'field' }, el('span', { textContent: 'Your colour' }),
          el('div', { className: 'sg-swatches' }, COLOURS.map((c) => el('button', {
            type: 'button', className: `sg-swatch${mineSlot.colour === c.hex ? ' on' : ''}`, style: `background:${c.hex}`, title: c.name,
            disabled: taken.has(c.hex), 'aria-label': c.name, onclick: () => colour(c.hex),
          })))),
        el('div', { className: 'field' }, el('span', { textContent: 'Your civilisation' }), civPick.button),
        el('p', { className: 'sg-note', textContent: 'Your colour shows on your name, buildings and the minimap; soldiers wear their team\'s blue or red.' })) : null,
    ];
  }

  // ---------- Into the game ----------
  async function launch(players, me, mode, seed, net) {
    show(el('p', { className: 'status', textContent: 'Getting the armies ready…' }));
    try {
      const kits = await Promise.all(players.map(async (p) => buildKit({ data, strings, tree: await loadTree(p.civ), civ: p.civ })));
      const assets = await loadAssets(kits);
      close();
      openGame({ data, kits, assets, players, me, mode, seed, net });
    } catch (err) {
      console.error(err);
      show(head('Wi-Fi game', menu), el('p', { className: 'status error', textContent: `Couldn't start: ${err.message}` }));
    }
  }

  menu();
}
