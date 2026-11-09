// NuNu Bridge, Foundry half.
// Runs in the GM's browser. Polls the local bridge server for jobs, answers
// them from the live world, and posts the answers back.
//
// Reads are always available. Writes are off by default and limited to document
// types that cannot carry code: no User, no Macro, no Scene, no Setting. Walls,
// drawings and a scene's own presentation fields are the exceptions, each written
// through its own operation against a list of the fields it is made of, because
// geometry, a shape with a caption, and the size and picture of a canvas carry
// nothing executable. There is deliberately no arbitrary-code operation.

const MOD = "nunu-bridge";
const POLL_TIMEOUT_MS = 40_000; // longer than the server's 25s hold
const POST_TIMEOUT_MS = 30_000;

let generation = 0;      // bumping this retires every running loop
let clientId = "";
let announced = false;

const setting = (key) => game.settings.get(MOD, key);

/* ----------------------------------------------------------------- reads */

const folderName = (d) => (typeof d.folder === "string" ? d.folder : d.folder?.name ?? null);

const slim = (d) => ({
  id: d.id,
  uuid: d.uuid ?? null,
  name: d.name ?? null,
  type: d.type ?? null,
  folder: folderName(d),
  img: d.img ?? null,
});

const COLLECTIONS = () => ({
  actors: game.actors, items: game.items, scenes: game.scenes,
  journal: game.journal, tables: game.tables, playlists: game.playlists,
  macros: game.macros, folders: game.folders, combats: game.combats,
  users: game.users, cards: game.cards,
});

const collection = (name) => {
  const c = COLLECTIONS()[name];
  if (!c) throw new Error(`unknown collection: ${name}. One of ${Object.keys(COLLECTIONS()).join(", ")}`);
  return c;
};

// Document types the bridge may write. Everything able to carry executable
// content or grant access is absent on purpose: User (GM accounts), Macro and
// Scene (region behaviours run scripts), Setting (permissions). A Scene's
// presentation fields are reachable through sceneCreate and sceneConfig, which
// cannot touch a region; see SCENE_FIELDS.
const WRITABLE = new Set(["Actor", "Item", "JournalEntry", "RollTable", "Folder"]);

const MAX_WALLS = 500; // a perimeter is four walls; a hand-traced room is dozens
const WALL_FIELDS = ["move", "sight", "sound", "light", "dir", "door", "ds", "threshold"];

const MAX_ACTOR_ITEMS = 100; // a full sheet's worth of gear, cyberware and programs
const MAX_DRAWINGS = 200; // a zone track is eight; a hand-marked map is dozens
const DRAWING_FIELDS = ["fillType", "fillColor", "fillAlpha", "strokeWidth", "strokeColor",
  "strokeAlpha", "text", "fontFamily", "fontSize", "textColor", "textAlpha", "rotation",
  "elevation", "sort", "locked", "hidden"];

// A Scene's presentation fields, and nothing else. Scene stays out of WRITABLE
// because a region behaviour runs a script, so the opening here is the shape of a
// scene rather than the document: how large it is, what picture is under it, how the
// grid is read and how it is lit. Absent on purpose and refused rather than dropped:
// regions and every other embedded collection, flags, ownership and _id. A caller
// that passes one is told, because silently ignoring it would read as success.
const SCENE_FIELDS = {
  name: 1, width: 1, height: 1, padding: 1, backgroundColor: 1,
  foreground: 1, foregroundElevation: 1, tokenVision: 1, weather: 1,
  navigation: 1, navName: 1, navOrder: 1, playlist: 1, playlistSound: 1,
  folder: 1, sort: 1,
  background: { src: 1, offsetX: 1, offsetY: 1, scaleX: 1, scaleY: 1, rotation: 1, tint: 1, fit: 1, alphaThreshold: 1 },
  grid: { type: 1, size: 1, style: 1, thickness: 1, color: 1, alpha: 1, distance: 1, units: 1 },
  initial: { x: 1, y: 1, scale: 1 },
  environment: { darknessLevel: 1, globalLight: { enabled: 1 } },
};

const sceneFields = (given, spec = SCENE_FIELDS, path = "") => {
  if (given === null || typeof given !== "object" || Array.isArray(given))
    throw new Error(`${path || "config"} must be an object.`);
  const out = {};
  for (const [k, v] of Object.entries(given)) {
    const here = path ? `${path}.${k}` : k;
    const rule = spec[k];
    if (!rule) throw new Error(`"${here}" is not a scene field the bridge will write.`);
    out[k] = rule === 1 ? v : sceneFields(v, rule, here);
  }
  return out;
};

// Changing the picture leaves the old thumbnail in the navigation bar, so it is
// regenerated here. A video background has no still frame to draw, and that is not
// a reason to fail a write that already went through.
const rethumb = async (s) => {
  try { await s.update({ thumb: (await s.createThumbnail()).thumb }); }
  catch (e) { console.warn("nunu-bridge | thumbnail:", e.message); }
};

// Walls are written through their own operations rather than this allowlist, because
// they are embedded in a Scene and have no world collection to be created into.
const assertWriteOn = () => {
  if (!setting("allowWrite")) throw new Error("writing is off. Tick 'Allow writes' in module settings.");
};

const assertWritable = (documentName) => {
  assertWriteOn();
  if (!WRITABLE.has(documentName)) throw new Error(`${documentName} cannot be written through the bridge. Allowed: ${[...WRITABLE].join(", ")}`);
  return getDocumentClass(documentName);
};

const hpOf = (actor) => {
  const hp = actor?.system?.derivedStats?.hp;
  if (!hp) return null; // blackIce, demon and container have no derivedStats
  return { value: hp.value ?? null, max: hp.max ?? null };
};

const OPS = Object.assign(Object.create(null), {
  ping: () => ({ world: game.world.id, system: `${game.system.id} ${game.system.version}`, core: game.version, user: game.user.name }),

  counts: () => ({
    actors: game.actors.size, items: game.items.size, scenes: game.scenes.size,
    journal: game.journal.size, tables: game.tables.size, playlists: game.playlists.size,
    macros: game.macros.size, combats: game.combats.size, folders: game.folders.size,
    users: game.users.size, packs: game.packs.size,
    modules: game.modules.filter((m) => m.active).length,
  }),

  list: ({ collection: name, type = null, limit = 0 }) => {
    let docs = collection(name).contents;
    if (type) docs = docs.filter((d) => d.type === type);
    if (limit) docs = docs.slice(0, limit);
    return docs.map(slim);
  },

  search: ({ collection: name, q, limit = 25 }) => {
    const needle = String(q ?? "").toLowerCase();
    return collection(name).contents
      .filter((d) => d.name?.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(slim);
  },

  get: async ({ uuid, collection: name, id }) => {
    const doc = uuid ? await fromUuid(uuid) : collection(name).get(id);
    if (!doc) throw new Error("not found");
    return doc.toObject(true);
  },

  // An actor plus the names of what it carries, which is usually the question.
  actor: ({ name, id }) => {
    const a = id ? game.actors.get(id) : game.actors.getName(name);
    if (!a) throw new Error(`no actor: ${name ?? id}`);
    const o = a.toObject(true);
    o._itemNames = a.items.map((i) => `${i.name} [${i.type}]`);
    return o;
  },

  scene: ({ name, id }) => {
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    return s.toObject(true);
  },

  packs: () => game.packs.map((p) => ({
    id: p.collection, label: p.metadata.label, type: p.documentName,
    package: p.metadata.packageName, size: p.index.size,
  })),

  packIndex: async ({ pack }) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`no pack: ${pack}`);
    return [...(await p.getIndex())].map((e) => ({ id: e._id, name: e.name, type: e.type ?? null }));
  },

  packDoc: async ({ pack, id, name }) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`no pack: ${pack}`);
    let doc = id ? await p.getDocument(id) : null;
    if (!doc && name) {
      const idx = [...(await p.getIndex())].find((e) => e.name === name);
      if (idx) doc = await p.getDocument(idx._id);
    }
    if (!doc) throw new Error("not found in pack");
    return doc.toObject(true);
  },

  modules: () => game.modules.map((m) => ({ id: m.id, title: m.title, version: m.version, active: m.active })),

  // Namespace is required, and this module's own settings are never returned,
  // because one of them is the token.
  settings: ({ namespace }) => {
    if (!namespace) throw new Error("settings needs a namespace, e.g. {\"namespace\":\"cyberpunk-red-core\"}");
    if (namespace === MOD) throw new Error("not that one");
    const out = {};
    for (const [key, cfg] of game.settings.settings) {
      if (cfg.namespace !== namespace) continue;
      try { out[key] = game.settings.get(cfg.namespace, cfg.key); } catch { /* unreadable */ }
    }
    return out;
  },

  // Chat, including Virtual Agent texts, which are chat messages carrying a
  // VirtualAgent flag rather than documents of their own.
  messages: ({ limit = 50, threadId = null, agentOnly = false, search = null }) => {
    let msgs = game.messages.contents;
    if (agentOnly) msgs = msgs.filter((m) => m.flags?.VirtualAgent?.isAgentMessage);
    if (threadId) msgs = msgs.filter((m) => m.flags?.VirtualAgent?.threadId === threadId);
    if (search) {
      const needle = String(search).toLowerCase();
      msgs = msgs.filter((m) => String(m.content ?? "").toLowerCase().includes(needle));
    }
    return msgs.slice(-Math.max(1, limit)).map((m) => {
      const va = m.flags?.VirtualAgent ?? {};
      return {
        id: m.id,
        time: new Date(m.timestamp).toISOString(),
        author: m.author?.name ?? m.user?.name ?? null,
        speaker: m.speaker?.alias ?? null,
        whisperedTo: m.whisper?.length ? m.whisper.map((id) => game.users.get(id)?.name ?? id) : null,
        thread: va.threadId ?? null,
        isAgentText: !!va.isAgentMessage,
        content: m.content,
      };
    });
  },

  // Every Virtual Agent conversation, newest activity first.
  threads: () => {
    const seen = new Map();
    for (const m of game.messages) {
      const va = m.flags?.VirtualAgent;
      if (!va?.isAgentMessage || !va.threadId) continue;
      const t = seen.get(va.threadId) ?? { thread: va.threadId, count: 0, last: null, lastContent: null };
      t.count++;
      if (!t.last || m.timestamp > Date.parse(t.last)) {
        t.last = new Date(m.timestamp).toISOString();
        t.lastContent = String(m.content ?? "").slice(0, 120);
      }
      seen.set(va.threadId, t);
    }
    return [...seen.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  },

  // Per-user Virtual Agent flags: contacts, wallet, housing, unlocked apps.
  userFlags: ({ user = null }) => {
    const users = user ? [game.users.getName(user) ?? game.users.get(user)].filter(Boolean) : game.users.contents;
    if (!users.length) throw new Error(`no user: ${user}`);
    return users.map((u) => ({ name: u.name, id: u.id, isGM: u.isGM, character: u.character?.name ?? null, flags: u.flags ?? {} }));
  },

  combat: () => {
    const c = game.combat;
    if (!c) return null;
    return {
      round: c.round, turn: c.turn, started: c.started, scene: c.scene?.name ?? null,
      combatants: c.turns.map((t) => ({
        name: t.name,
        initiative: t.initiative,
        hp: hpOf(t.actor),
        defeated: t.isDefeated,
      })),
    };
  },

  /* ---------------------------------------------------------------- writes */

  create: async ({ documentName, data, pack = null }) => {
    const cls = assertWritable(documentName);
    const docs = await cls.createDocuments(Array.isArray(data) ? data : [data], pack ? { pack } : {});
    return docs.map(slim);
  },

  update: async ({ documentName, updates, pack = null }) => {
    const cls = assertWritable(documentName);
    const docs = await cls.updateDocuments(Array.isArray(updates) ? updates : [updates], pack ? { pack } : {});
    return docs.map(slim);
  },

  /* Walls, and only walls. A Scene cannot be written through the bridge because a
     Scene carries region behaviours, which run scripts. A Wall carries none: it is
     two endpoints and a handful of flags saying what it blocks. So walls get their
     own three operations rather than an opening into Scene. */

  walls: ({ scene: name, id }) => {
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    return s.walls.map((w) => ({
      id: w.id, c: w.c, move: w.move, sight: w.sight, sound: w.sound,
      light: w.light, door: w.door, ds: w.ds, dir: w.dir,
    }));
  },

  wallCreate: async ({ scene: name, id, walls }) => {
    assertWriteOn();
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    const given = Array.isArray(walls) ? walls : [walls];
    if (!given.length) throw new Error("no walls given.");
    if (given.length > MAX_WALLS) throw new Error(`${given.length} walls in one call; the limit is ${MAX_WALLS}.`);
    const list = given.map((w) => {
      if (!Array.isArray(w?.c) || w.c.length !== 4 || w.c.some((n) => !Number.isFinite(n)))
        throw new Error("every wall needs c: [x1, y1, x2, y2], four finite numbers.");
      // Only the fields a wall is made of. Nothing else is copied across, flags
      // included, so a wall written through here stays geometry and nothing more.
      const out = { c: w.c.map(Number) };
      for (const k of WALL_FIELDS) if (w[k] !== undefined) out[k] = w[k];
      return out;
    });
    const made = await s.createEmbeddedDocuments("Wall", list);
    return made.map((w) => ({ id: w.id, c: w.c }));
  },

  wallDelete: async ({ scene: name, id, ids, all = false }) => {
    assertWriteOn();
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    if (all && ids !== undefined) throw new Error("pass ids or all, not both.");
    const targets = all ? s.walls.map((w) => w.id) : (Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]);
    if (!targets.length) return { deleted: 0 };
    await s.deleteEmbeddedDocuments("Wall", targets);
    return { deleted: targets.length };
  },

  /* Drawings, and only drawings, on the same reasoning as walls. A Drawing is a shape,
     a colour and a string of text. Unlike a Scene it carries no region behaviours, and
     unlike a Macro it carries nothing that runs, so it is a narrower opening than the
     wall operations already are. Shapes are limited to rectangles, ellipses and
     polylines; `text` is stored and rendered as text and never evaluated. */

  drawings: ({ scene: name, id }) => {
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    return s.drawings.map((d) => ({
      id: d.id, x: d.x, y: d.y, shape: d.shape?.toObject?.() ?? d.shape,
      text: d.text, locked: d.locked, hidden: d.hidden, flags: d.flags,
    }));
  },

  drawingCreate: async ({ scene: name, id, drawings }) => {
    assertWriteOn();
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    const given = Array.isArray(drawings) ? drawings : [drawings];
    if (!given.length) throw new Error("no drawings given.");
    if (given.length > MAX_DRAWINGS) throw new Error(`${given.length} drawings in one call; the limit is ${MAX_DRAWINGS}.`);
    const list = given.map((d) => {
      if (!Number.isFinite(d?.x) || !Number.isFinite(d?.y)) throw new Error("every drawing needs finite x and y.");
      const type = d?.shape?.type ?? "r";
      if (!["r", "e", "p"].includes(type)) throw new Error(`shape type "${type}": use r, e or p.`);
      const shape = { type };
      for (const k of ["width", "height", "radius", "points"]) if (d.shape?.[k] !== undefined) shape[k] = d.shape[k];
      // Only the fields a drawing is made of, so nothing arbitrary rides along in flags.
      const out = { x: Number(d.x), y: Number(d.y), shape };
      for (const k of DRAWING_FIELDS) if (d[k] !== undefined) out[k] = d[k];
      if (d.tag !== undefined) out.flags = { "nunu-bridge": { tag: String(d.tag) } };
      return out;
    });
    const made = await s.createEmbeddedDocuments("Drawing", list);
    return made.map((d) => ({ id: d.id, x: d.x, y: d.y }));
  },

  drawingDelete: async ({ scene: name, id, ids, tag, all = false }) => {
    assertWriteOn();
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    const given = [all, tag !== undefined, ids !== undefined].filter(Boolean).length;
    if (given > 1) throw new Error("pass ids, tag or all, and only one of them.");
    const targets = all ? s.drawings.map((d) => d.id)
      : tag !== undefined ? s.drawings.filter((d) => d.flags?.["nunu-bridge"]?.tag === String(tag)).map((d) => d.id)
      : (Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]);
    if (!targets.length) return { deleted: 0 };
    await s.deleteEmbeddedDocuments("Drawing", targets);
    return { deleted: targets.length };
  },

  /* Scenes, through their presentation fields only. The document itself stays out of
     WRITABLE for the reason given at SCENE_FIELDS: its regions can carry behaviours that
     run scripts. Neither operation below can reach a region, an embedded collection, a
     flag or ownership, so what they write is the size of the canvas, the picture under
     it, how the grid is read and how it is lit. */

  sceneCreate: async ({ config }) => {
    assertWriteOn();
    const data = sceneFields(config);
    if (!data.name) throw new Error("a new scene needs a name.");
    const made = await getDocumentClass("Scene").create(data);
    if (data.background?.src) await rethumb(made);
    return { id: made.id, name: made.name, width: made.width, height: made.height };
  },

  sceneConfig: async ({ scene: name, id, config }) => {
    assertWriteOn();
    const s = id ? game.scenes.get(id) : game.scenes.getName(name);
    if (!s) throw new Error(`no scene: ${name ?? id}`);
    const data = sceneFields(config);
    if (!Object.keys(data).length) throw new Error("no scene fields given.");
    await s.update(data);
    if (data.background?.src !== undefined) await rethumb(s);
    return {
      id: s.id, name: s.name, width: s.width, height: s.height,
      background: s.background?.src ?? null,
      grid: { type: s.grid.type, size: s.grid.size, distance: s.grid.distance, units: s.grid.units },
    };
  },

  /* Items on an actor. `create` and `update` reach world collections, and an Item owned by
     an actor lives in that actor instead, so a sheet cannot be built through them at all.
     Item is already writable here, so this is the same document type under a different
     parent rather than a wider permission. */

  actorItemCreate: async ({ actor: name, id, items }) => {
    assertWriteOn();
    const a = id ? game.actors.get(id) : game.actors.getName(name);
    if (!a) throw new Error(`no actor: ${name ?? id}`);
    const given = Array.isArray(items) ? items : [items];
    if (!given.length) throw new Error("no items given.");
    if (given.length > MAX_ACTOR_ITEMS) throw new Error(`${given.length} items in one call; the limit is ${MAX_ACTOR_ITEMS}.`);
    for (const it of given) if (!it?.name || !it?.type) throw new Error("every item needs a name and a type.");
    const made = await a.createEmbeddedDocuments("Item", given);
    return made.map((i) => ({ id: i.id, name: i.name, type: i.type }));
  },

  actorItemUpdate: async ({ actor: name, id, updates }) => {
    assertWriteOn();
    const a = id ? game.actors.get(id) : game.actors.getName(name);
    if (!a) throw new Error(`no actor: ${name ?? id}`);
    const given = Array.isArray(updates) ? updates : [updates];
    // A name is accepted in place of an _id, because an actor's own skills are addressed
    // by what they are called and their ids are not knowable from outside the sheet.
    const list = given.map((u) => {
      if (u?._id) return u;
      const hit = a.items.find((i) => i.name === u?.name && (!u.type || i.type === u.type));
      if (!hit) throw new Error(`no item named "${u?.name}" on ${a.name}.`);
      const { name: _drop, type: _drop2, ...rest } = u;
      return { _id: hit.id, ...rest };
    });
    const docs = await a.updateEmbeddedDocuments("Item", list);
    return docs.map((i) => ({ id: i.id, name: i.name, type: i.type }));
  },

  actorItemDelete: async ({ actor: name, id, ids }) => {
    assertWriteOn();
    const a = id ? game.actors.get(id) : game.actors.getName(name);
    if (!a) throw new Error(`no actor: ${name ?? id}`);
    const targets = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!targets.length) return { deleted: 0 };
    await a.deleteEmbeddedDocuments("Item", targets);
    return { deleted: targets.length };
  },

  delete: async ({ documentName, ids, pack = null }) => {
    const cls = assertWritable(documentName);
    const docs = await cls.deleteDocuments(Array.isArray(ids) ? ids : [ids], pack ? { pack } : {});
    return docs.map(slim);
  },
});

/* ------------------------------------------------------------------ loop */

const fetchWithTimeout = (url, options, ms) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer));
};

async function answer(job, base, token) {
  let payload;
  try {
    const op = Object.hasOwn(OPS, job.op) ? OPS[job.op] : null;
    if (!op) throw new Error(`unknown op: ${job.op}. One of ${Object.keys(OPS).join(", ")}`);
    payload = { id: job.id, ok: true, data: await op(job.args ?? {}) };
  } catch (err) {
    payload = { id: job.id, ok: false, error: String(err?.message ?? err) };
  }
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    body = JSON.stringify({ id: job.id, ok: false, error: `result could not be serialised: ${String(err?.message ?? err)}` });
  }
  await fetchWithTimeout(
    `${base}/result?token=${encodeURIComponent(token)}&client=${clientId}`,
    { method: "POST", headers: { "content-type": "text/plain" }, body }, // text/plain keeps it a simple request
    POST_TIMEOUT_MS
  );
}

async function loop() {
  if (!game.user?.isGM) return;
  const mine = ++generation;
  clientId = foundry.utils.randomID();
  let backoff = 1000;

  while (mine === generation && setting("enabled")) {
    const base = `http://127.0.0.1:${setting("port")}`;
    const token = setting("token");
    if (!token) { ui.notifications.warn("NuNu Bridge: no token set."); break; }
    try {
      const res = await fetchWithTimeout(`${base}/next?token=${encodeURIComponent(token)}&client=${clientId}`, {}, POLL_TIMEOUT_MS);
      if (res.status === 200) {
        if (!announced) { ui.notifications.info("NuNu Bridge connected."); announced = true; }
        backoff = 1000;
        await answer(await res.json(), base, token);
      } else if (res.status === 204) {
        if (!announced) { ui.notifications.info("NuNu Bridge connected."); announced = true; }
        backoff = 1000;
      } else if (res.status === 403) {
        ui.notifications.error("NuNu Bridge: token rejected. Check module settings.");
        break;
      } else {
        announced = false;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    } catch {
      announced = false;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  if (mine === generation) announced = false;
}

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MOD, key, { scope: "client", config: true, ...data });
  reg("enabled", {
    name: "Bridge enabled",
    hint: "Connect this browser to the bridge server running on this machine. GM only.",
    type: Boolean,
    default: false,
    onChange: (v) => { if (v) loop(); else generation++; },
  });
  reg("port", { name: "Port", hint: "Must match the server.", type: Number, default: 7777, onChange: () => { if (setting("enabled")) { generation++; loop(); } } });
  reg("token", { name: "Token", hint: "From ~/.config/nunu-bridge/token on this machine.", type: String, default: "", onChange: () => { if (setting("enabled")) { generation++; loop(); } } });
  reg("allowWrite", {
    name: "Allow writes",
    hint: "Lets the bridge create, update and delete actors, items, journals, tables, folders, and the walls and drawings on a scene. Leave off unless you are actively using it.",
    type: Boolean,
    default: false,
  });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  if (setting("enabled")) loop();
});
