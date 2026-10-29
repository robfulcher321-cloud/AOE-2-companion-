// Turns a build order into a timeline: which step you are on, how many
// villagers should be on each resource, and an estimate of what you should
// have banked. Times are in-game seconds, as in the build orders.
//
// The bank is an estimate, not game data: villagers gather at typical
// in-game rates (including walking), and the costs of what each step says to
// build, research or train are paid from when that step starts, as soon as
// there is enough (like a player waiting for the resources).

export const VILLAGER_TIME = 25;          // seconds to train a villager
export const START_BANK = { food: 200, wood: 200, gold: 100, stone: 200 };
// Typical gather rates per villager per second, walking included (approximate).
export const RATES = { food: 0.33, wood: 0.36, gold: 0.35, stone: 0.33 };
export const RES_KEYS = ['food', 'wood', 'gold', 'stone'];

// What the icons in build-order notes cost. Keys are the icon file names.
// Costs are filled from the game data where it has them (see costFromData).
const ICONS = {
  'other/House_aoe2DE.webp': ['Building', 70],
  'lumber_camp/Lumber_camp_aoe2de.webp': ['Building', 562],
  'mill/Mill_aoe2de.webp': ['Building', 68],
  'mining_camp/Mining_camp_aoe2de.webp': ['Building', 584],
  'mill/FarmDE.webp': ['Building', 50],
  'barracks/Barracks_aoe2DE.webp': ['Building', 12],
  'blacksmith/Blacksmith_aoe2de.webp': ['Building', 103],
  'market/Market_aoe2DE.webp': ['Building', 84],
  'archery_range/Archery_range_aoe2DE.webp': ['Building', 87],
  'stable/Stable_aoe2DE.webp': ['Building', 101],
  'town_center/Towncenter_aoe2DE.webp': ['Building', 109],
  'monastery/MonasteryAoe2DE.webp': ['Building', 104],
  'castle/Castle_aoe2DE.webp': ['Building', 82],
  'siege_workshop/Siege_workshop_aoe2DE.webp': ['Building', 49],
  'university/University_AoE2_DE.webp': ['Building', 209],
  'defensive_structures/Tower_aoe2de.webp': ['Building', 79],
  'town_center/LoomDE.webp': ['Tech', 22],
  'lumber_camp/DoubleBitAxe_aoe2DE.webp': ['Tech', 202],
  'mill/HorseCollarDE.webp': ['Tech', 14],
  'town_center/WheelbarrowDE.webp': ['Tech', 213],
  'lumber_camp/BowSawDE.webp': ['Tech', 203],
  'mining_camp/GoldMiningDE.webp': ['Tech', 55],
  'stable/BloodlinesDE.webp': ['Tech', 435],
  'blacksmith/FletchingDE.webp': ['Tech', 199],
  'blacksmith/Forging_aoe2de.webp': ['Tech', 67],
  'blacksmith/BodkinArrowDE.webp': ['Tech', 200],
  'archery_range/ThumbRingDE.webp': ['Tech', 437],
  'mill/HeavyPlowDE.webp': ['Tech', 13],
  'town_center/HandcartDE.webp': ['Tech', 249],
  'stable/HusbandryDE.webp': ['Tech', 39],
  'blacksmith/ScaleBardingArmorDE.webp': ['Tech', 81],
  'university/ChemistryDE.webp': ['Tech', 47],
  'university/BallisticsDE.webp': ['Tech', 93],
  'monastery/RedemptionDE.webp': ['Tech', 316],
  'barracks/ManAtArmsUpgDE.webp': ['Fixed', { Food: 100, Gold: 40 }],
  'archery_range/Crossbowman_aoe2DE.webp': ['Fixed', { Food: 125, Gold: 75 }],
  'stable/Scoutcavalry_aoe2DE.webp': ['Unit', 448],
  'stable/Knight_aoe2DE.webp': ['Unit', 38],
  'archery_range/Archer_aoe2DE.webp': ['Unit', 4],
  'barracks/MilitiaDE.webp': ['Unit', 74],
  'barracks/Spearman_aoe2DE.webp': ['Unit', 93],
  'barracks/Eaglescout_aoe2DE.webp': ['Unit', 751],
  'barracks/Eaglewarrior_aoe2DE.webp': ['Unit', 753],
  'archery_range/Cavalryarcher_aoe2DE.webp': ['Unit', 39],
  'monastery/Monk_aoe2DE.webp': ['Unit', 125],
  'archery_range/Hand_cannoneer_aoe2DE.webp': ['Unit', 5],
  'stable/Steppelancericon.webp': ['Unit', 1370],
  'stable/Battle_elephant_aoe2DE.webp': ['Unit', 1132],
  'siege_workshop/Battering_ram_aoe2DE.webp': ['Unit', 1258],
  'siege_workshop/Mangonel_aoe2DE.webp': ['Unit', 280],
  'siege_workshop/Scorpion_aoe2DE.webp': ['Unit', 279],
  'siege_workshop/Bombard_cannon_aoe2DE.webp': ['Unit', 36],
  'unique_unit/OrganGunIcon-DE.webp': ['Unit', 1001],
  'siege_workshop/Rocket_Cart.webp': ['Unit', 1904],
  'barracks/Fire_Lancer.webp': ['Unit', 1901],
  'unique_unit/Aoe2de_ratha_ranged.webp': ['Unit', 1759],
  'unique_unit/Aoe2-icon-hussite-wagon.webp': ['Unit', 1704],
  'unique_unit/Aoe2-icon-flemish-militia.webp': ['Unit', 1699],
};
// Age-up icons -> age-up tech (101 Feudal, 102 Castle, 103 Imperial)
const AGE_ICON = { 2: 'age/FeudalAgeIconDE', 3: 'age/CastleAgeIconDE', 4: 'age/ImperialAgeIconDE' };
const AGE_TECH = { 2: 101, 3: 102, 4: 103 };
const VERB = /\b(build|builds|built|seed|seeds|research|researches|get|make|makes|train|trains|queue|add|click|drop|start making|produce)\b/i;

const lower = (c) => Object.fromEntries(Object.entries(c || {}).map(([k, v]) => [k.toLowerCase(), v]));

export function parseTime(s) {
  if (typeof s === 'number') return s;
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Note text split into plain text and icon tokens: [{text} | {icon}] */
export function tokens(note) {
  return String(note).split('@').map((part, i) => (i % 2 ? { icon: part } : { text: part })).filter((t) => t.icon || t.text);
}

function costOf(icon, data) {
  const def = ICONS[icon];
  if (!def) return null;
  const [type, ref] = def;
  if (type === 'Fixed') return { type, cost: lower(ref) };
  const e = data?.data?.[type]?.[ref];
  return e?.Cost ? { type, cost: lower(e.Cost) } : null;
}

/** What one note says to pay for: [{ icon, n, cost }] */
function purchases(note, data, seenTechs) {
  const out = [];
  for (const seg of String(note).split('|')) {
    const parts = tokens(seg);
    let before = '';
    for (const p of parts) {
      if (p.text) { before += p.text; continue; }
      const c = costOf(p.icon, data);
      if (c) {
        if (c.type === 'Tech' || c.type === 'Fixed') {
          if (!seenTechs.has(p.icon)) { seenTechs.add(p.icon); out.push({ icon: p.icon, n: 1, cost: c.cost }); }
        } else if (VERB.test(before)) {
          const m = before.match(/(\d+)\s*$/);
          out.push({ icon: p.icon, n: m ? Number(m[1]) : 1, cost: c.cost });
        }
      }
      before += ' ';
    }
  }
  return out;
}

/** The build order as a timeline with an estimated bank, second by second. */
export function timeline(build, data) {
  const raw = build.build_order || [];
  const steps = [];
  let prevT = 0;
  let prevV = 3;
  let prevRes = { food: 3, wood: 0, gold: 0, stone: 0, builder: 0 };
  for (const s of raw) {
    // -1 in a build order means "not given": keep what the previous step had.
    const vills = s.villager_count >= 0 ? s.villager_count : prevV;
    const res = { ...prevRes };
    for (const k of Object.keys(res)) {
      const v = s.resources?.[k];
      if (typeof v === 'number' && v >= 0) res[k] = v;
      else if (k === 'builder') res[k] = 0;
    }
    let t = parseTime(s.time);
    if (t === null || t < prevT) t = prevT + Math.max(10, (vills - prevV) * VILLAGER_TIME);
    steps.push({ ...s, t, start: prevT, vills, res });
    prevT = t;
    prevV = vills;
    prevRes = res;
  }
  const end = (steps.at(-1)?.t || 0) + 90;

  // Spending events: villagers, age-ups and what the notes say to buy.
  // Also, for the scrolling practice view: where each new villager goes and
  // which villagers move between resources at each step.
  const events = [];
  const villagers = [];
  const moves = [];
  const seenTechs = new Set();
  const KEYS = ['food', 'wood', 'gold', 'stone', 'builder'];
  let vPrev = 3;
  let rPrev = { food: 3, wood: 0, gold: 0, stone: 0, builder: 0 };
  steps.forEach((st, si) => {
    const made = Math.max(0, st.vills - vPrev);
    // New villagers fill the resources that grow; anything left over is a move.
    const gains = KEYS.flatMap((k) => Array(Math.max(0, Math.round(st.res[k] - rPrev[k]))).fill(k));
    const losses = KEYS.flatMap((k) => Array(Math.max(0, Math.round(rPrev[k] - st.res[k]))).fill(k));
    for (let k = 1; k <= made; k++) {
      // Villagers are queued one training time before each is due.
      const done = st.start + ((st.t - st.start) * k) / made;
      const q = Math.max(0, done - VILLAGER_TIME);
      events.push({ t: q, cost: { food: 50 }, what: 'villager' });
      villagers.push({ q, done, res: gains.shift() || null, step: si });
    }
    const moved = new Map();
    while (gains.length && losses.length) {
      const key = `${losses[0]}>${gains[0]}`;
      moved.set(key, (moved.get(key) || 0) + 1);
      losses.shift(); gains.shift();
    }
    for (const [key, n] of moved) {
      const [from, to] = key.split('>');
      moves.push({ t: st.start, from, to, n, step: si });
    }
    vPrev = Math.max(vPrev, st.vills);
    rPrev = { ...st.res };
    // What this step says to buy, spread across the step in the order it's written.
    const buys = (st.notes || []).flatMap((note) => purchases(note, data, seenTechs));
    buys.forEach((p, k) => {
      const t = st.start + ((st.t - st.start) * (k + 0.5)) / buys.length;
      const cost = Object.fromEntries(Object.entries(p.cost).map(([key, v]) => [key, v * p.n]));
      events.push({ t, cost, what: p.icon, n: p.n, step: si });
    });
  });
  // Age-ups: clicked at the "N pop" step that names the age, else when the age changes.
  const ages = [];
  for (let i = 1; i < steps.length; i++) {
    const age = steps[i].age;
    if (age <= steps[i - 1].age) continue;
    let click = steps[i].start;
    for (let j = i - 1; j >= 0 && steps[j].age === age - 1; j--) {
      const note = (steps[j].notes || []).join(' ');
      if (!note.includes(`@${AGE_ICON[age]}`)) continue;
      const m = note.match(new RegExp(`(\\d+)\\s*pop\\s*@${AGE_ICON[age].replace('/', '\\/')}(_alpha)?\\.webp@`, 'i'));
      click = steps[j].t + (m ? Math.max(0, Number(m[1]) - 1 - steps[j].vills) * VILLAGER_TIME : 0);
      break;
    }
    const tech = data?.data?.Tech?.[AGE_TECH[age]];
    events.push({ t: click, cost: lower(tech?.Cost || {}), what: `age${age}`, icon: `${AGE_ICON[age]}.webp` });
    ages.push({ age, click, reach: click + (tech?.ResearchTime || 130), pop: steps[i - 1].vills + 1 });
  }
  events.sort((a, b) => a.t - b.t);

  // Villagers on each resource at time t, easing from one step to the next.
  const alloc = (t) => {
    let prev = { food: 3, wood: 0, gold: 0, stone: 0, builder: 0 };
    for (const st of steps) {
      if (t <= st.t) {
        const k = st.t > st.start ? Math.max(0, Math.min(1, (t - st.start) / (st.t - st.start))) : 1;
        return Object.fromEntries(Object.keys(prev).map((key) => [key, prev[key] + ((st.res[key] || 0) - prev[key]) * k]));
      }
      prev = { ...prev, ...st.res };
    }
    return prev;
  };

  // Second-by-second bank estimate. Purchases wait until they're affordable.
  const bank = [];
  const cur = { ...START_BANK };
  let e = 0;
  const queue = [];
  const affordable = (c) => Object.entries(c).every(([k, v]) => !(k in cur) || cur[k] >= v - 1e-9);
  for (let t = 0; t <= end; t++) {
    while (e < events.length && events[e].t <= t) queue.push(events[e++]);
    for (let q = 0; q < queue.length;) {
      if (affordable(queue[q].cost)) {
        for (const [k, v] of Object.entries(queue[q].cost)) if (k in cur) cur[k] -= v;
        queue[q].paidAt = t;
        queue.splice(q, 1);
      } else q++;
    }
    bank.push({ ...cur });
    const a = alloc(t + 0.5);
    for (const k of RES_KEYS) cur[k] += (a[k] || 0) * RATES[k];
  }

  const bankAt = (t) => {
    const i = Math.max(0, Math.min(bank.length - 1, Math.floor(t)));
    const j = Math.min(bank.length - 1, i + 1);
    const f = Math.max(0, Math.min(1, t - i));
    return Object.fromEntries(RES_KEYS.map((k) => [k, bank[i][k] + (bank[j][k] - bank[i][k]) * f]));
  };
  return {
    steps,
    end,
    ages,
    events,
    villagers,
    moves,
    alloc,
    bankAt,
    /** Villagers trained by time t (3 to start) */
    villagersAt: (t) => 3 + villagers.filter((v) => v.done <= t).length,
    /** Index of the step you are working towards at time t */
    stepAt: (t) => {
      const i = steps.findIndex((st) => t < st.t);
      return i === -1 ? steps.length - 1 : i;
    },
  };
}

/** Summary for the overview: age timings, buildings, units and techs mentioned. */
export function overview(build, data) {
  const tl = timeline(build, data);
  const icons = new Map();
  for (const st of tl.steps) for (const note of st.notes || []) for (const tk of tokens(note)) if (tk.icon) icons.set(tk.icon, (icons.get(tk.icon) || 0) + 1);
  const pick = (type) => [...icons.keys()].filter((ic) => ICONS[ic]?.[0] === type || (type === 'Tech' && ICONS[ic]?.[0] === 'Fixed'));
  const last = tl.steps.at(-1);
  return {
    tl,
    ages: tl.ages,
    finalVills: last?.vills,
    finalTime: last?.t,
    finalAlloc: last?.res,
    buildings: pick('Building'),
    units: pick('Unit'),
    techs: pick('Tech'),
  };
}
