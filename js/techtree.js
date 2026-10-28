import { loadCore, loadTree, imageUrl, civIconUrl, cleanText, className, nameText } from './data.js';

const AGE_ICONS = ['dark', 'feudal', 'castle', 'imperial'].map((a) => `img/ages/${a}.png`);
const AGE_STRING_IDS = [4201, 4202, 4203, 4204];
const ABSENT = 'NotAvailable';

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) n.append(c);
  return n;
};

export function civKeys(data, strings) {
  return Object.keys(data.civs)
    .filter((k) => data.civs[k].era !== 'antiquity')
    .sort((a, b) => (strings[data.civs[a].name_string_id] || a)
      .localeCompare(strings[data.civs[b].name_string_id] || b));
}

export function civOptions(data, strings) {
  return civKeys(data, strings).map((k) => ({ value: k, label: nameText(strings[data.civs[k].name_string_id] || k), icon: civIconUrl(k) }));
}

export async function renderTree(civKey, { body, blurb, openSheet }) {
  const { data, strings } = await loadCore();
  const tree = await loadTree(civKey);
  const nodes = new Map(tree.units_techs.map((n) => [n.id, n]));

  blurb.textContent = cleanText(strings[data.civs[civKey].help_string_id]);

  const frag = document.createDocumentFragment();
  const plainBuildings = [];

  for (const b of tree.buildings) {
    const items = (b.grid || []).flat().filter(Boolean);
    if (!items.length) { plainBuildings.push(b); continue; }

    const section = el('section', { className: 'building' });
    section.append(el('div', { className: 'building-head' },
      el('img', { src: imageUrl('Building', b.picture_index), alt: '', loading: 'lazy', width: 36, height: 36 }),
      el('h2', { textContent: nameText(strings[b.name_string_id] || b.name) })));

    // The grid has two rows per age.
    for (let age = 0; age < 4; age++) {
      const rowNodes = [b.grid[age * 2], b.grid[age * 2 + 1]]
        .flat().filter(Boolean).map((id) => nodes.get(id)).filter(Boolean);
      if (!rowNodes.length) continue;
      const items = el('div', { className: 'items' }, ...rowNodes.map((n) => itemButton(n, strings, openSheet, data)));
      section.append(el('div', { className: `age-row age-${age + 1}` },
        el('img', { className: 'age-mark', src: AGE_ICONS[age], alt: strings[AGE_STRING_IDS[age]] || `Age ${age + 1}`, title: strings[AGE_STRING_IDS[age]], width: 34, height: 42 }),
        items));
    }
    frag.append(section);
  }

  if (plainBuildings.length) {
    const seen = new Set();
    const chips = plainBuildings.filter((b) => !seen.has(b.name) && seen.add(b.name))
      .map((b) => itemButton({ ...b, use_type: 'Building' }, strings, openSheet, data));
    frag.append(el('section', { className: 'building' },
      el('div', { className: 'building-head' }, el('h2', { textContent: 'Other buildings' })),
      el('div', { className: 'items' }, ...chips)));
  }

  body.replaceChildren(frag);
}

function itemButton(node, strings, openSheet, data) {
  const absent = node.node_status === ABSENT;
  const type = node.use_type; // Unit | Tech | Building
  const name = nameText(strings[node.name_string_id] || node.name);
  // Tile colours follow the in-game tech tree: units blue, techs green,
  // buildings orange, unique units purple, regional variants lighter.
  const kind = {
    Unit: 'unit', UnitUpgrade: 'unit', RegionalUnit: 'regional-unit', UniqueUnit: 'unique-unit',
    Research: 'tech', RegionalTech: 'regional-tech', UniqueTech: 'unique-tech',
  }[node.node_type] || (type === 'Building' ? 'building' : type.toLowerCase());
  const btn = el('button', {
    type: 'button',
    className: `item ${kind}${absent ? ' absent' : ''}`,
    title: absent ? `${name} (not available)` : name,
  },
  el('span', { className: 'item-icon' },
    el('img', { src: imageUrl(type, node.picture_index), alt: '', loading: 'lazy', width: 48, height: 48 }),
    absent ? el('img', { className: 'item-cross', src: 'img/cross.png', alt: '' }) : null),
  el('span', { className: 'item-name', textContent: name }));
  btn.addEventListener('click', () => openSheet(detailView(node, name, absent, strings, data)));
  return btn;
}

/**
 * The game's description for a unit, tech or building. The tree data points at
 * the tooltip string; the full description sits 79000 IDs below it.
 */
function helpText(strings, helpStringId) {
  let raw = strings[helpStringId - 79000] ?? '';
  raw = raw.replace(/\n/g, '').replace(/‹[^›]*›/g, '');
  raw = raw.replace(/^.*?\([^)]*\)\s*<br>/, '');            // "Research <b>X</b> (cost)" heading
  let upgrades = '';
  raw = raw.replace(/<i>([\s\S]*?)<\/i>/, (_, inner) => { upgrades = cleanText(inner); return ''; });
  return { description: cleanText(raw), upgrades };
}

function costText(cost) {
  if (!cost) return '—';
  const parts = Object.entries(cost).filter(([, v]) => v).map(([k, v]) => `${v} ${k.toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'Free';
}

function detailView(node, name, absent, strings, data) {
  const type = node.use_type;
  const record = data.data[type]?.[node.node_id] || data.data[type]?.[String(node.node_id)];
  const wrap = el('div');
  const ageName = node.age_id ? strings[AGE_STRING_IDS[node.age_id - 1]] : '';
  wrap.append(el('div', { className: 'sheet-title' },
    el('img', { src: imageUrl(type, node.picture_index), alt: '' }),
    el('div', {},
      el('h2', { id: 'sheet-title', textContent: name }),
      el('p', { textContent: [ageName, absent ? 'Not available to this civilisation' : null].filter(Boolean).join('. ') }))));

  const stats = el('dl', { className: 'stats' });
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') stats.append(el('div', {}, el('dt', { textContent: k }), el('dd', { textContent: v }))); };
  if (record) {
    add('Cost', costText(record.Cost));
    if (type === 'Tech') add('Research time', `${record.ResearchTime}s`);
    if (type === 'Unit') {
      add('Train time', `${record.TrainTime}s`);
      add('Hit points', record.HP);
      add('Attack', record.Attack);
      add('Melee armour', record.MeleeArmor);
      add('Pierce armour', record.PierceArmor);
      if (record.Range) add('Range', record.MinRange ? `${record.MinRange}–${record.Range}` : record.Range);
      add('Reload', `${record.ReloadTime}s`);
      add('Speed', record.Speed);
      add('Line of sight', record.LineOfSight);
      if (record.Range && record.AccuracyPercent !== 100) add('Accuracy', `${record.AccuracyPercent}%`);
    }
    if (type === 'Building') { add('Hit points', record.HP); add('Build time', record.TrainTime ? `${record.TrainTime}s` : null); }
  }
  wrap.append(stats);

  if (type === 'Unit' && record) {
    const bonuses = (record.Attacks || []).filter((a) => a.Amount > 0 && a.Class !== 4 && a.Class !== 3);
    if (bonuses.length) {
      wrap.append(el('h3', { textContent: 'Bonus damage' }),
        el('ul', { className: 'bonus-list' }, ...bonuses.map((a) => el('li', { textContent: `+${a.Amount} vs ${className(a.Class)}` }))));
    }
  }

  const { description, upgrades } = helpText(strings, node.help_string_id);
  if (description) wrap.append(el('p', { className: 'help', textContent: description }));
  if (upgrades) wrap.append(el('p', { className: 'help subtle', textContent: upgrades }));
  return wrap;
}
