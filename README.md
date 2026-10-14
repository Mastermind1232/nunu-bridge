# NuNu Bridge

Lets tooling on this machine read the live Foundry world.

Foundry's server is hosted on The Forge, but the game itself runs in the GM's
browser, on this machine. This module polls a small server running locally,
answers its questions from the live world, and posts the answers back. Nothing
leaves the machine and no third party is involved.

## Running it

    node server/server.mjs

On first run it writes a token to `~/.config/nunu-bridge/token`, outside this
folder so it can never be committed or shipped in a release zip. In Foundry,
open the module settings, paste the token, and tick **Bridge enabled**.

Chrome may ask once for permission to reach a local address. Allow it.

## Asking it things

    TOKEN=$(cat ~/.config/nunu-bridge/token)
    curl -s -X POST "http://127.0.0.1:7777/ask?token=$TOKEN" \
      -d '{"op":"counts"}'

Reads: `ping`, `counts`, `list`, `search`, `get`, `actor`, `scene`, `walls`,
`packs`, `packIndex`, `packDoc`, `modules`, `settings`, `combat`, `messages`,
`threads`, `userFlags`.

    {"op":"list","args":{"collection":"scenes"}}
    {"op":"actor","args":{"name":"Doctor Crane"}}
    {"op":"search","args":{"collection":"items","q":"wings"}}
    {"op":"packIndex","args":{"pack":"cyberpunk-red-core.cyberware"}}
    {"op":"messages","args":{"agentOnly":true,"limit":100}}
    {"op":"settings","args":{"namespace":"VirtualAgent"}}

## Writing

`create`, `update` and `delete` refuse to run unless **Allow writes** is ticked,
and only accept Actor, Item, JournalEntry, RollTable and Folder.

User, Macro, Scene and Setting are deliberately absent. Through those a write
operation becomes something much larger than a write: a User document can mint a
GM account, a Macro and a Scene region behaviour both execute arbitrary
JavaScript, and a Setting can rewrite the world's permissions. There is no
arbitrary-code operation for the same reason.

    {"op":"wallCreate","args":{"scene":"Ruby Rose Casino","walls":[{"c":[0,0,3840,0]}]}}
    {"op":"wallDelete","args":{"scene":"Ruby Rose Casino","all":true}}

**Walls** are the one embedded exception, and they have their own operations
rather than an opening into Scene. A Scene is unwritable because of what it
carries; a wall is two endpoints and a few flags saying what it blocks, with
nothing executable in it. `wallCreate` takes only the fields a wall is made of,
so nothing else on the object is copied across, document flags included, and it
refuses more than 500 walls in one call. `wallDelete` takes ids, or `all` to
clear the scene. Both need **Allow writes**.

## What it is guarded against

- Every route requires the token, which lives outside this folder.
- Only `/next` and `/result`, the two routes the browser needs, carry CORS
  headers, and only for a Forge or localhost origin. A page on any other site
  cannot read a reply, so a site you happen to be visiting cannot read your
  world.
- The `Host` header is pinned to loopback, so a hostile domain pointed at
  127.0.0.1 is refused.
- The `settings` operation requires a namespace and refuses its own, so the
  token cannot be read back out through it.
- A job may only be answered by the client it was handed to.
- Jobs that time out are removed from the queue, so an abandoned job cannot run
  later against the world.

## Limits

- Only works while a GM has the world open in a browser tab on this machine.
- Returns document data, not the asset files themselves.
- Write permission is stored in this browser, so any module installed in the
  world could in principle turn it on. The document allowlist is what bounds the
  damage, not the toggle.
