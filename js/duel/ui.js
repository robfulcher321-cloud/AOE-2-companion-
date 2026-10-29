import { loadCore, loadTree, imageUrl, civIconUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { UNIT_CLASS, CIV_EFFECTS } from './effects.js';
import { civKeys } from '../techtree.js';
import { buildFighter, isDuelEligible, damagePerHit, hitsToKill, affectsUnit, trackFor, otherTechsFor, CLASS } from './combat.js';
import { simulateMany } from './sim.js';
import { ArenaPlayer } from './render.js';
import { loadPack } from './spritepack.js';

const OTHER_NOTES = { 435: '+20 HP', 437: 'accuracy, fire rate', 436: 'armour, bonus damage', 47: '+1 attack', 215: '+10% speed', 39: '+10% speed', 93: 'arrows lead moving targets' };

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) n.append(c);
  return n;
};

class SidePanel {
  constructor(root, label, defaults, onChange) {
    this.root = root;
    this.label = label;
    this.defaults = defaults;
    this.onChange = onChange;
  }

  async init(data, strings) {
    this.data = data; this.strings = strings;
    const civName = (k) => nameText(strings[data.civs[k].name_string_id] || k);
    this.civName = civName;
    this.civPicker = new Picker({ label: 'Civilisation', onChange: (civ) => this.setCiv(civ) });
    this.civPicker.setOptions(civKeys(data, strings).map((k) => ({ value: k, label: civName(k), icon: civIconUrl(k) })), this.defaults.civ);
    this.unitPicker = new Picker({ label: 'Unit', onChange: () => this.refreshUnit() });
    this.attackSelect = el('select');
    this.armourSelect = el('select');
    this.otherBox = el('div', { className: 'ut-list' });
    this.utBox = el('div', { className: 'ut-list' });
    this.bonusNote = el('p', { className: 'bonus-note' });
    this.extras = {};
    const num = (key, text) => {
      const input = el('input', { type: 'number', step: 1, value: 0, inputMode: 'numeric' });
      this.extras[key] = input;
      return el('label', { className: 'field' }, el('span', { textContent: text }), input);
    };
    this.statline = el('p', { className: 'statline' });
    this.specialNote = el('p', { className: 'special-note' });

    this.root.replaceChildren(
      el('legend', { textContent: this.label }),
      el('div', { className: 'field' }, el('span', { textContent: 'Civilisation' }), this.civPicker.button),
      el('div', { className: 'field' }, el('span', { textContent: 'Unit' }), this.unitPicker.button),
      this.countRow(),
      el('div', { className: 'upgrade-grid' },
        el('label', { className: 'field' }, el('span', { textContent: 'Attack upgrades' }), this.attackSelect),
        el('label', { className: 'field' }, el('span', { textContent: 'Armour upgrades' }), this.armourSelect)),
      this.otherBox,
      this.utBox,
      this.bonusNote,
      this.specialNote,
      el('details', { className: 'extra' },
        el('summary', { textContent: 'Manual adjustments' }),
        el('div', { className: 'extra-grid' },
          el('p', { className: 'extra-note', textContent: 'For effects the simulator doesn\'t model yet. Added on top of everything else.' }),
          num('attack', 'Extra attack'), num('hp', 'Extra HP'),
          num('meleeArmour', 'Extra melee armour'), num('pierceArmour', 'Extra pierce armour'))),
      this.statline,
    );

    for (const n of [this.attackSelect, this.armourSelect, ...Object.values(this.extras)]) {
      n.addEventListener('input', () => this.update());
    }
    await this.setCiv(this.defaults.civ, this.defaults.unit);
  }

  /** 1–5 units on this side */
  countRow() {
    this.count = 1;
    const group = el('div', { className: 'count', role: 'radiogroup', 'aria-label': `${this.label} unit count` });
    this.countButtons = [1, 2, 3, 4, 5].map((n) => {
      const btn = el('button', { type: 'button', textContent: String(n) });
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(n === 1));
      btn.addEventListener('click', () => {
        this.count = n;
        for (const b of this.countButtons) b.setAttribute('aria-checked', String(b === btn));
        this.onChange?.();
      });
      group.append(btn);
      return btn;
    });
    return el('div', { className: 'field' }, el('span', { textContent: 'How many' }), group);
  }

  async setCiv(civ, preferredUnit) {
    this.civ = civ;
    const tree = await loadTree(civ);
    const available = (n) => n.node_status !== 'NotAvailable';
    this.techNodes = new Map(tree.units_techs.filter((n) => n.use_type === 'Tech').map((n) => [n.node_id, n]));
    this.techOk = new Set([...this.techNodes.values()].filter(available).map((n) => n.node_id));
    const prev = preferredUnit ?? this.unitPicker.value;
    this.units = new Map();
    for (const node of tree.units_techs) {
      const unit = this.data.data.Unit[node.node_id];
      if (node.use_type !== 'Unit' || !available(node) || !isDuelEligible(unit) || this.units.has(node.node_id)) continue;
      this.units.set(node.node_id, { node, unit });
    }
    this.unitPicker.setOptions([...this.units.values()].map(({ node }) => ({
      value: node.node_id,
      label: nameText(this.strings[node.name_string_id] || node.name),
      icon: imageUrl('Unit', node.picture_index),
    })), this.units.has(prev) ? prev : undefined);
    this.refreshUnit();
  }

  levelsAvailable(techs) {
    let n = 0;
    while (n < techs.length && this.techOk.has(techs[n])) n++;
    return n;
  }

  refreshUnit() {
    const pick = this.units.get(this.unitPicker.value);
    if (!pick) return;
    const { unit } = pick;
    const civ = this.civName(this.civ);
    // Every level is listed; ones this civ can't research are shown but disabled.
    const fill = (select, names, applies, max) => {
      const keep = select.value;
      select.replaceChildren(...names.map((t, i) => el('option', {
        value: i,
        textContent: i > max ? `${t} (not available)` : t,
        disabled: i > max,
      })));
      select.value = keep !== '' && Number(keep) <= max ? keep : String(max);
      select.disabled = !applies;
    };
    // The Blacksmith line that upgrades this unit (Forging or Fletching; mail,
    // barding or archer armour), read from the techs' own effects.
    const atk = trackFor(unit, 'attack');
    const arm = trackFor(unit, 'armour');
    const short = (n) => n.replace(/ (Armor|Arrow)$/, '');
    fill(this.attackSelect, ['None', ...(atk?.names || ['Forging', 'Iron Casting', 'Blast Furnace']).map(short)], Boolean(atk), atk ? this.levelsAvailable(atk.techs) : 0);
    fill(this.armourSelect, ['None', ...(arm?.names || ['Scale Mail', 'Chain Mail', 'Plate Mail']).map(short)], Boolean(arm), arm ? this.levelsAvailable(arm.techs) : 0);

    // Single upgrades that change this unit (Bloodlines, Thumb Ring, Chemistry...).
    // Ones the civ can't research are shown but switched off.
    const sameUnit = this.lastUnit === unit.ID && this.lastCiv === this.civ;
    const prevOther = new Set(this.otherInputs?.filter((i) => i.checked).map((i) => Number(i.value)) || []);
    this.otherInputs = [];
    const others = otherTechsFor(unit);
    this.otherBox.replaceChildren(el('h3', { textContent: 'Other upgrades' }), ...others.map((t) => {
      const ok = this.techOk.has(t.id);
      const node = this.techNodes.get(t.id);
      const input = el('input', { type: 'checkbox', value: t.id, disabled: !ok, checked: ok && (sameUnit ? prevOther.has(t.id) : true) });
      input.addEventListener('input', () => this.update());
      this.otherInputs.push(input);
      return el('label', { className: `toggle${ok ? '' : ' unavailable'}` }, input,
        el('span', {}, node ? nameText(this.strings[node.name_string_id] || t.name) : t.name, ' ',
          el('small', { textContent: ok ? `(${OTHER_NOTES[t.id]})` : `(not available to ${civ})` })));
    }));
    this.otherBox.hidden = others.length === 0;

    // Unique techs: the civ's Castle techs, each switchable; ones that don't
    // change this unit's stats are shown greyed out.
    const me = { id: unit.ID, cls: UNIT_CLASS[unit.ID] };
    const uts = (CIV_EFFECTS[this.civ]?.uts || []).filter((u) => this.techNodes.has(u.id) && this.techOk.has(u.id));
    const prevOn = new Set(this.utInputs?.filter((i) => i.checked).map((i) => Number(i.value)) || []);
    this.utInputs = [];
    this.utBox.replaceChildren(el('h3', { textContent: 'Unique techs' }), ...uts.map((u) => {
      const node = this.techNodes.get(u.id);
      const relevant = affectsUnit(u, me);
      const input = el('input', { type: 'checkbox', value: u.id, disabled: !relevant,
        checked: relevant && (this.lastUnit === unit.ID && this.lastCiv === this.civ ? prevOn.has(u.id) : true) });
      input.addEventListener('input', () => this.update());
      this.utInputs.push(input);
      return el('label', { className: `toggle${relevant ? '' : ' unavailable'}` }, input,
        el('span', {}, nameText(this.strings[node.name_string_id] || node.name), ' ',
          el('small', { textContent: relevant ? '' : '(doesn\'t change this unit)' })));
    }));
    this.utBox.hidden = uts.length === 0;
    this.lastUnit = unit.ID;
    this.lastCiv = this.civ;
    this.update();
  }

  fighter() {
    const pick = this.units.get(this.unitPicker.value);
    if (!pick) return null;
    const name = nameText(this.strings[pick.node.name_string_id] || pick.node.name);
    return {
      count: this.count,
      icon: imageUrl('Unit', pick.node.picture_index),
      stats: buildFighter(pick.unit, name, {
        civ: this.civ,
        attackLevel: Number(this.attackSelect.value) || 0,
        armourLevel: Number(this.armourSelect.value) || 0,
        techs: this.otherInputs.filter((i) => i.checked).map((i) => Number(i.value)),
        uts: this.utInputs.filter((i) => i.checked).map((i) => Number(i.value)),
        extra: Object.fromEntries(Object.entries(this.extras).map(([k, v]) => [k, Number(v.value) || 0])),
        units: this.data.data.Unit,
      }),
    };
  }

  update() {
    const f = this.fighter();
    if (!f) return;
    const s = f.stats;
    const r = (v) => Math.round(v * 100) / 100;
    // Game data names age steps separately ("... Age3", "... Age4"); show each bonus once.
    const counts = new Map();
    for (const b of s.bonuses) {
      const name = b.replace(/\s*\+\s*BL$/, '').replace(/\s+Age\s*\d$/i, '').replace(/\binf cav\b/gi, 'Infantry & Cavalry').replace(/\binf\b/gi, 'Infantry').replace(/\bcav\b/gi, 'Cavalry');
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const names = [...counts].map(([n, c]) => (c > 1 && /Age/.test(s.bonuses.join()) ? `${n} (×${c}, by Imperial)` : n));
    this.bonusNote.textContent = names.length
      ? `Civ bonuses applied: ${names.join('; ')}.`
      : 'No civ bonuses change this unit.';
    const p = s.projectile;
    const attack = p ? `${r(s.attacks.get(CLASS.PIERCE) ?? 0)} pierce attack` : `${r(s.attacks.get(CLASS.MELEE) ?? 0)} attack`;
    const shots = p ? `${p.count > 1 ? `, ${p.count} arrows per shot` : ''}, range ${r(s.range)}, ${Math.round(p.accuracy)}% accuracy` : s.range >= 1 ? `, reach ${r(s.range)}` : '';
    const sp = describeSpecial(s);
    this.specialNote.textContent = sp ? `Special: ${sp}` : '';
    this.specialNote.hidden = !sp;
    this.statline.textContent =
      `${Math.floor(s.hp)} HP, ${attack}, ` +
      `${r(s.armours.get(CLASS.MELEE) ?? 0)}/${r(s.armours.get(CLASS.PIERCE) ?? 0)} armour, ` +
      `${r(s.reload)}s reload, ${r(s.speed)} speed${shots}`;
    this.onChange?.();
  }
}

/** One line describing a unit's special abilities, as the simulator uses them. */
function describeSpecial(f) {
  const sp = f.special || {};
  const out = [];
  const ch = sp.charge;
  const secs = (c) => Math.round(c.max / c.rate);
  const r = (v) => Math.round(v * 100) / 100;
  if (ch) {
    const shotDmg = (p) => [...p.attacks].filter(([c]) => c === 3).map(([, a]) => a)[0] ?? 0;
    switch (ch.type) {
      case 1: if (ch.event === 1) out.push(`charged blow +${r(ch.max)} damage, recharges in ${secs(ch)} s`); break;
      case 3: out.push(`charged sweep +${r(ch.max)} damage to the target and enemies around it, recharges in ${secs(ch)} s`); break;
      case 4: out.push(`dodges up to ${r(ch.max)} projectiles, 1 back every ${r(1 / ch.rate)} s`); break;
      case 5: out.push(`blocks one melee blow every ${secs(ch)} s`); break;
      case 6:
        if (ch.projectile && !f.projectile) out.push(`${ch.projectile.count > 1 ? `${ch.projectile.count} shots` : 'a throw'} of ${shotDmg(ch.projectile)} pierce from up to ${r(ch.event)} tiles before closing in, recharges in ${secs(ch)} s`);
        else if (ch.projectile) out.push(`charged shot of ${shotDmg(ch.projectile)} pierce every ${secs(ch)} s`);
        break;
      case 7: out.push(`charged volley of ${1 + (ch.extra?.count || 0)} arrows every ${secs(ch)} s`); break;
      default:
    }
  }
  if (sp.rush) out.push(`charges in ${Math.round((sp.rush.speed - 1) * 100)}% faster from ${sp.rush.from}–${sp.rush.to} tiles`);
  if (sp.blast) out.push(sp.blast.damage < 0 ? `trample: ${-sp.blast.damage} damage to enemies within ${r(sp.blast.width)} tiles` : `trample: ${Math.round(sp.blast.damage * 100)}% damage to enemies within ${r(sp.blast.width)} tiles`);
  if (sp.combat & 1) out.push('ignores armour');
  if (sp.combat & 4) out.push('tears 1 melee and pierce armour per hit');
  if (sp.bonusResist) out.push(`takes ${Math.round(sp.bonusResist * 100)}% less bonus damage`);
  if (sp.regen) out.push(`regenerates ${r(sp.regen)} HP per minute`);
  if (sp.reflect) out.push(`reflects ${Math.round(sp.reflect * 100)}% of melee damage`);
  if (f.dismount) out.push(`fights on as ${f.dismount.name.replace(' (on foot)', '')} on foot (${Math.floor(f.dismount.hp)} HP) when its horse falls`);
  return out.join('; ');
}

export async function initDuel() {
  const { data, strings } = await loadCore();
  const a = new SidePanel(document.getElementById('side-a'), 'Blue', { civ: 'Teutons', unit: 554 });
  const b = new SidePanel(document.getElementById('side-b'), 'Red', { civ: 'Franks', unit: 569 });
  await Promise.all([a.init(data, strings), b.init(data, strings)]);

  const wrap = document.getElementById('arena-wrap');
  const player = new ArenaPlayer(document.getElementById('arena'));
  const resultBox = document.getElementById('result');
  let current = null;
  const pack = await loadPack();
  const packText = document.getElementById('pack-text');
  const showPack = (message) => { packText.textContent = message || ''; packText.hidden = !message; };
  if (!pack) showPack('In-game graphics couldn\'t be loaded, so units are shown as icons.');

  // Sprites for every unit that can appear (including a Konnik's dismounted
  // form) and every projectile they can throw or fire.
  const spritesFor = async (fa, fb) => {
    if (!pack) return null;
    const fighters = [fa.stats, fb.stats];
    const unitIds = new Set();
    const shotNames = new Set();
    for (let f of fighters) {
      for (; f; f = f.dismount) {
        unitIds.add(f.unitId);
        for (const p of [f.projectile, f.special?.charge?.projectile, f.special?.charge?.extra]) if (p?.sprite) shotNames.add(p.sprite);
      }
    }
    if (![fa.stats.unitId, fb.stats.unitId].every((id) => pack.has(id))) return null;
    try {
      const units = {};
      const projectiles = {};
      await Promise.all([
        ...[...unitIds].filter((id) => pack.has(id)).map(async (id) => { units[id] = await pack.unit(id); }),
        ...[...shotNames].map(async (n) => { projectiles[n] = await pack.projectile(n); }),
      ]);
      return { grass: await pack.grass(), units, projectiles };
    } catch (err) {
      console.warn(err);
      return null;
    }
  };

  const fightBtn = document.getElementById('fight');
  const run = async () => {
    const fa = a.fighter();
    const fb = b.fighter();
    if (!fa || !fb) return;
    fightBtn.disabled = true;
    fightBtn.textContent = 'Simulating…';
    await new Promise((r) => setTimeout(r, 30)); // let the button repaint first
    const counts = [fa.count, fb.count];
    // Fewer samples for big battles keeps it quick on a phone.
    const runs = counts[0] + counts[1] > 4 ? 100 : 200;
    const many = simulateMany(fa.stats, fb.stats, { counts, runs });
    const { result } = many;
    fightBtn.disabled = false;
    fightBtn.textContent = 'Fight';
    const sprites = await spritesFor(fa, fb);
    showPack(pack && !sprites ? 'This matchup has no in-game graphics, so it\'s shown with icons.' : '');
    const icons = await Promise.all([fa.icon, fb.icon].map((src) => new Promise((res) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = img.onerror = () => res(img);
      img.src = src;
    })));
    current = { result, many, fa: fa.stats, fb: fb.stats, counts };
    wrap.hidden = false;
    resultBox.replaceChildren();
    player.resize();
    player.load(result, icons, sprites);
    player.onDone = () => showResult(resultBox, current);
    player.play();
    wrap.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };

  fightBtn.addEventListener('click', run);
  document.getElementById('replay').addEventListener('click', () => { if (current) { resultBox.replaceChildren(); player.play(); } });
  for (const btn of document.querySelectorAll('.speed button')) {
    btn.addEventListener('click', () => {
      player.speed = Number(btn.dataset.speed);
      for (const o of document.querySelectorAll('.speed button')) o.setAttribute('aria-pressed', String(o === btn));
    });
  }
}

function showResult(box, { result, many, fa, fb, counts }) {
  const names = [fa.name, fb.name];
  const sideNames = ['Blue', 'Red'];
  const plural = (n, name) => {
    if (n < 2) return name;
    if (/man$/.test(name)) return `${n} ${name.slice(0, -3)}men`;
    if (/(s|i)$/.test(name)) return `${n} ${name}`;
    if (/[^aeiou]y$/.test(name)) return `${n} ${name.slice(0, -1)}ies`;
    return `${n} ${name}s`;
  };
  const label = (i) => plural(counts[i], names[i]);
  const pct = (x) => `${Math.round(x * 100)}%`;
  let heading;
  let odds = null;
  const winsVerb = (i) => (counts[i] > 1 ? 'win' : 'wins');
  if (many.runs > 1) {
    const [w0, w1, draw] = many.rates;
    const top = w0 >= w1 ? 0 : 1;
    heading = Math.max(w0, w1) < 0.55 && Math.abs(w0 - w1) < 0.1
      ? 'Too close to call'
      : `${sideNames[top]}'s ${label(top)} ${winsVerb(top)} ${pct(many.rates[top])} of fights`;
    odds = el('p', { className: 'odds' },
      `Out of ${many.runs} fights with different dice rolls for shots: Blue ${pct(w0)}, Red ${pct(w1)}`,
      draw ? `, everyone dies ${pct(draw)}` : '', '. The fight shown is a typical one.');
  } else {
    heading = result.winner === null
      ? (result.timedOut ? 'No winner after 10 minutes' : 'Everyone died')
      : `${sideNames[result.winner]}'s ${label(result.winner)} ${winsVerb(result.winner)}`;
  }
  const fighters = [fa, fb];
  const S = result.sides;
  const row = (title, f) => el('tr', {}, el('th', { scope: 'row', textContent: title }),
    el('td', { textContent: f(0) }), el('td', { textContent: f(1) }));
  const multi = counts[0] > 1 || counts[1] > 1;
  const table = el('table', { className: 'result-table' },
    el('thead', {}, el('tr', {}, el('th', {}), el('th', { textContent: `Blue: ${label(0)}` }), el('th', { textContent: `Red: ${label(1)}` }))),
    el('tbody', {},
      multi ? row('Units left', (i) => `${S[i].survivors} / ${S[i].count}`) : null,
      row(multi ? 'HP left (all units)' : 'HP left', (i) => `${Math.ceil(S[i].hpLeft)} / ${Math.floor(S[i].hpTotal)}`),
      row('Damage per hit', (i) => Math.round(damagePerHit(fighters[i], fighters[1 - i]) * 100) / 100),
      row('Hits to kill one', (i) => hitsToKill(fighters[i], fighters[1 - i]) + (fighters[i].projectile?.secondary ? ' (main arrow)' : '')),
      row('Hits landed', (i) => (fighters[i].projectile ? `${S[i].hits} of ${S[i].shots} shots` : S[i].hits)),
      row('Damage dealt', (i) => Math.round(S[i].dealt)),
    ));
  box.replaceChildren(...[
    el('h2', { textContent: heading }),
    odds,
    el('p', { className: 'subtle', textContent: `${odds ? 'This fight' : 'Fight'} lasted ${result.duration.toFixed(1)} game seconds (${(result.duration / 1.7).toFixed(1)} real seconds at Normal speed).` }),
    table,
    el('p', { className: 'caveat', textContent: 'Imperial Age, flat ground, no micro: units go for the nearest enemy, and ranged units stand and shoot rather than running from melee units. Shots roll accuracy, fly at their real speed, can be dodged by sideways movement without Ballistics, and misses can still hit. Includes Blacksmith, Archery Range, Stable, Barracks and University upgrades, civ bonuses and unique techs that change unit stats. Special abilities come from the game data: charge attacks and charge shots, trample, dodging, blocking, armour-ignoring and tearing, regeneration from techs and civ bonuses, and the Konnik fighting on foot. Not yet simulated: the Bolas Rider\'s slow, the Berserk\'s built-in regeneration and hero auras.' }),
  ].filter(Boolean));
}
