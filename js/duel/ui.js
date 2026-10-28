import { loadCore, loadTree, imageUrl, nameText } from '../data.js';
import { civKeys } from '../techtree.js';
import { BLACKSMITH, buildFighter, isDuelEligible, isCavalry, isInfantry, damagePerHit, hitsToKill, CLASS } from './combat.js';
import { simulate } from './sim.js';
import { ArenaPlayer } from './render.js';

const LEVEL_NAMES = {
  attack: ['None', 'Forging', 'Iron Casting', 'Blast Furnace'],
  inf: ['None', 'Scale Mail', 'Chain Mail', 'Plate Mail'],
  cav: ['None', 'Scale Barding', 'Chain Barding', 'Plate Barding'],
};

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
    const civSelect = el('select', { 'aria-label': `${this.label} civilisation` });
    for (const k of civKeys(data, strings)) civSelect.append(el('option', { value: k, textContent: nameText(strings[data.civs[k].name_string_id] || k) }));
    civSelect.value = this.defaults.civ;
    this.unitImg = el('img', { alt: '', width: 52, height: 52 });
    this.unitSelect = el('select', { 'aria-label': `${this.label} unit` });
    this.attackSelect = el('select');
    this.armourSelect = el('select');
    this.bloodlines = el('input', { type: 'checkbox', checked: true });
    this.bloodlinesRow = el('label', { className: 'toggle' }, this.bloodlines, 'Bloodlines (+20 HP)');
    this.extras = {};
    const num = (key, text) => {
      const input = el('input', { type: 'number', step: 1, value: 0, inputMode: 'numeric' });
      this.extras[key] = input;
      return el('label', { className: 'field' }, el('span', { textContent: text }), input);
    };
    this.statline = el('p', { className: 'statline' });

    this.root.replaceChildren(
      el('legend', { textContent: this.label }),
      el('label', { className: 'field' }, el('span', { textContent: 'Civilisation' }), civSelect),
      el('div', { className: 'pick-unit' }, this.unitImg,
        el('label', { className: 'field' }, el('span', { textContent: 'Unit' }), this.unitSelect)),
      el('div', { className: 'upgrade-grid' },
        el('label', { className: 'field' }, el('span', { textContent: 'Attack upgrades' }), this.attackSelect),
        el('label', { className: 'field' }, el('span', { textContent: 'Armour upgrades' }), this.armourSelect)),
      this.bloodlinesRow,
      el('details', { className: 'extra' },
        el('summary', { textContent: 'Unique techs and civ bonuses' }),
        el('div', { className: 'extra-grid' },
          el('p', { className: 'extra-note', textContent: 'Not applied automatically yet. Add their effect by hand, for example +2 attack for a civ bonus.' }),
          num('attack', 'Extra attack'), num('hp', 'Extra HP'),
          num('meleeArmour', 'Extra melee armour'), num('pierceArmour', 'Extra pierce armour'))),
      this.statline,
    );

    civSelect.addEventListener('change', () => this.setCiv(civSelect.value));
    this.unitSelect.addEventListener('change', () => this.refreshUnit());
    for (const n of [this.attackSelect, this.armourSelect, this.bloodlines, ...Object.values(this.extras)]) {
      n.addEventListener('input', () => this.update());
    }
    await this.setCiv(this.defaults.civ, this.defaults.unit);
  }

  async setCiv(civ, preferredUnit) {
    this.civ = civ;
    const tree = await loadTree(civ);
    this.tree = tree;
    const available = (n) => n.node_status !== 'NotAvailable';
    this.techOk = new Set(tree.units_techs.filter((n) => n.use_type === 'Tech' && available(n)).map((n) => n.node_id));
    const prev = preferredUnit ?? Number(this.unitSelect.value);
    const units = tree.units_techs
      .filter((n) => n.use_type === 'Unit' && available(n))
      .map((n) => ({ node: n, unit: this.data.data.Unit[n.node_id] }))
      .filter(({ unit }) => isDuelEligible(unit));
    const seen = new Set();
    this.units = new Map();
    this.unitSelect.replaceChildren();
    for (const { node, unit } of units) {
      if (seen.has(node.node_id)) continue;
      seen.add(node.node_id);
      this.units.set(node.node_id, { node, unit });
      this.unitSelect.append(el('option', { value: node.node_id, textContent: nameText(this.strings[node.name_string_id] || node.name) }));
    }
    if (this.units.has(prev)) this.unitSelect.value = String(prev);
    this.refreshUnit();
  }

  levelsAvailable(techs) {
    let n = 0;
    while (n < techs.length && this.techOk.has(techs[n])) n++;
    return n;
  }

  refreshUnit() {
    const pick = this.units.get(Number(this.unitSelect.value));
    if (!pick) return;
    const { node, unit } = pick;
    this.unitImg.src = imageUrl('Unit', node.picture_index);
    const cav = isCavalry(unit);
    const inf = isInfantry(unit);
    const fill = (select, names, max) => {
      const keep = select.value;
      select.replaceChildren(...names.slice(0, max + 1).map((t, i) => el('option', { value: i, textContent: t })));
      select.value = keep && Number(keep) <= max ? keep : String(max);
      select.disabled = max === 0;
    };
    fill(this.attackSelect, LEVEL_NAMES.attack, (cav || inf) ? this.levelsAvailable(BLACKSMITH.attack.techs) : 0);
    const armourTrack = cav ? BLACKSMITH.cavalryArmour : inf ? BLACKSMITH.infantryArmour : null;
    fill(this.armourSelect, cav ? LEVEL_NAMES.cav : LEVEL_NAMES.inf, armourTrack ? this.levelsAvailable(armourTrack.techs) : 0);
    const hasBloodlines = cav && this.techOk.has(BLACKSMITH.bloodlines.tech);
    this.bloodlinesRow.hidden = !hasBloodlines;
    if (!hasBloodlines) this.bloodlines.checked = false;
    else if (this.lastUnit !== unit.ID) this.bloodlines.checked = true;
    this.lastUnit = unit.ID;
    this.update();
  }

  fighter() {
    const pick = this.units.get(Number(this.unitSelect.value));
    if (!pick) return null;
    const name = nameText(this.strings[pick.node.name_string_id] || pick.node.name);
    return {
      icon: imageUrl('Unit', pick.node.picture_index),
      stats: buildFighter(pick.unit, name, {
        attackLevel: Number(this.attackSelect.value) || 0,
        armourLevel: Number(this.armourSelect.value) || 0,
        bloodlines: this.bloodlines.checked,
        extra: Object.fromEntries(Object.entries(this.extras).map(([k, v]) => [k, Number(v.value) || 0])),
      }),
    };
  }

  update() {
    const f = this.fighter();
    if (!f) return;
    const s = f.stats;
    this.statline.textContent =
      `${s.hp} HP, ${s.attacks.get(CLASS.MELEE) ?? 0} attack, ` +
      `${s.armours.get(CLASS.MELEE) ?? 0}/${s.armours.get(CLASS.PIERCE) ?? 0} armour, ${s.reload}s reload`;
    this.onChange?.();
  }
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

  const run = async () => {
    const fa = a.fighter();
    const fb = b.fighter();
    if (!fa || !fb) return;
    const result = simulate(fa.stats, fb.stats);
    const icons = await Promise.all([fa.icon, fb.icon].map((src) => new Promise((res) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = img.onerror = () => res(img);
      img.src = src;
    })));
    current = { result, fa: fa.stats, fb: fb.stats };
    wrap.hidden = false;
    resultBox.replaceChildren();
    player.resize();
    player.load(result, icons);
    player.onDone = () => showResult(resultBox, current);
    player.play();
    wrap.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };

  document.getElementById('fight').addEventListener('click', run);
  document.getElementById('replay').addEventListener('click', () => { if (current) { resultBox.replaceChildren(); player.play(); } });
  for (const btn of document.querySelectorAll('.speed button')) {
    btn.addEventListener('click', () => {
      player.speed = Number(btn.dataset.speed);
      for (const o of document.querySelectorAll('.speed button')) o.setAttribute('aria-pressed', String(o === btn));
    });
  }
}

function showResult(box, { result, fa, fb }) {
  const names = [fa.name, fb.name];
  const sideNames = ['Blue', 'Red'];
  const heading = result.winner === null
    ? (result.timedOut ? 'No winner after 10 minutes' : 'Both units died')
    : `${sideNames[result.winner]}'s ${names[result.winner]} wins`;
  const fighters = [fa, fb];
  const row = (label, f) => el('tr', {}, el('th', { scope: 'row', textContent: label }),
    el('td', { textContent: f(0) }), el('td', { textContent: f(1) }));
  const table = el('table', { className: 'result-table' },
    el('thead', {}, el('tr', {}, el('th', {}), el('th', { textContent: `Blue: ${names[0]}` }), el('th', { textContent: `Red: ${names[1]}` }))),
    el('tbody', {},
      row('HP left', (i) => `${Math.ceil(result.sides[i].hpLeft)} / ${fighters[i].hp}`),
      row('Damage per hit', (i) => damagePerHit(fighters[i], fighters[1 - i])),
      row('Hits to kill', (i) => hitsToKill(fighters[i], fighters[1 - i])),
      row('Hits landed', (i) => result.sides[i].hits),
    ));
  box.replaceChildren(
    el('h2', { textContent: heading }),
    el('p', { className: 'subtle', textContent: `Fight lasted ${result.duration.toFixed(1)} game seconds (${(result.duration / 1.7).toFixed(1)} real seconds at Normal speed).` }),
    table,
    el('p', { className: 'caveat', textContent: 'Uses base stats and Blacksmith upgrades on flat ground. Civ bonuses, unique techs, charge attacks and trample are not included yet, and results haven\'t been checked against the real game.' }),
  );
}
