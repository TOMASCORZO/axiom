/**
 * Realtime reference — explains the manifest + SDK the agent uses to ship
 * any multiplayer feature (chat, lobby, matchmaking, shared state, enemies,
 * clan wars, Among Us-style rooms, Clash Royale-style matches, etc.).
 *
 * Injected into the system prompt so the agent uses the real surface instead
 * of guessing from training data.
 */

export function getRealtimeReference(): string {
    return `## Realtime / Multiplayer

Every game ships with a per-project realtime surface. Two parts:

1. **Manifest** (\`realtime.axiom.json\`) — declares WHAT the game has: chat, rooms, presence, shared state, custom events. Editable only via \`configure_realtime\`. The Realtime Studio panel renders one widget per declared feature, so if it isn't in the manifest, the user can't see it.
2. **SDK** (\`axiom.channel(topic)\`) — how game code actually subscribes / broadcasts. Topics you use here MUST match a manifest feature's \`topic\`. The SDK auto-prefixes \`game:<project_id>:\`, and Supabase RLS enforces the prefix.

### When to call \`configure_realtime\`

Call it the moment the user asks for anything multiplayer-ish:
- chat (global or per-room)
- lobbies / rooms / matches / clan wars / parties
- shared positions, enemies, NPC sync, physics state
- turn-based game state (cards, tiles, moves)
- matchmaking / ready-up flows
- presence (who's online)
- custom announcements (leaderboard updates, tournament events)

Then (separately) write game code that calls \`axiom.channel(feature.topic)\` and uses the declared event names / fields.

### Feature kinds

**chat** — text messages on a channel.
  { id, label, topic, kind:'chat', scope:'global'|'room', persist?, maxLength? }
  Studio renders message bubbles filtered by event name 'message' or 'chat'.
  Payload convention: { player_id, text, at? }.

**rooms** — joinable instances (matches, lobbies, parties).
  { id, label, topic, kind:'rooms', roomKind:'match'|'lobby'|..., maxPlayers?, metaFields? }
  Events on the topic: room_opened / room_updated / room_closed, each with { room_id, meta? }.
  Each room has its own child topic (e.g. \`${'${topic}'}:<room_id>\`) for chat/state inside the room.

**presence** — who is currently connected, with per-player fields.
  { id, label, topic, kind:'presence', fields:[{name, type}] }
  Use \`ch.track({...})\` from the game; Studio shows each player's tracked payload.

**state** — shared game state snapshot (enemies, scores, positions).
  { id, label, topic, kind:'state', fields:[{name, type}], tickHz? }
  Broadcast event name 'sync' (or anything) with the fields as payload.
  Studio shows the latest snapshot.

**events** — typed custom events with known names/fields (leaderboard changes, achievements, etc.).
  { id, label, topic, kind:'events', events:[{name, fields?, persist?}] }
  Studio shows timeline filtered to declared event names.

**custom** — anything that doesn't fit above. Last resort.

### Field types
string | number | boolean | vector2 | vector3 | json | player_id | timestamp

### Topic naming
Topics are suffixes — \`lobby\`, \`match:123\`, \`chat-global\`. Lowercase, numbers, \`:\`, \`_\`, \`-\`. The SDK auto-adds \`game:<project_id>:\` before sending. Never hardcode \`game:\` into the topic you pass to configure_realtime.

### Example — Among Us-style lobby + chat

1. \`configure_realtime({ operation:'set_feature', feature:{ id:'lobby', kind:'rooms', label:'Lobby', topic:'lobby', roomKind:'lobby', maxPlayers:10, metaFields:[{name:'host', type:'player_id'},{name:'started', type:'boolean'}] } })\`
2. \`configure_realtime({ operation:'set_feature', feature:{ id:'lobby-chat', kind:'chat', label:'Lobby chat', topic:'lobby-chat', scope:'room' } })\`
3. \`configure_realtime({ operation:'set_feature', feature:{ id:'game-state', kind:'state', label:'In-game state', topic:'match', fields:[{name:'tasks_done', type:'number'},{name:'alive', type:'json'}], tickHz:5 } })\`
4. Then write_game_logic that calls \`axiom.channel('lobby')\`, \`axiom.channel('lobby-chat:<roomId>')\`, etc.

### Example — Clash Royale-style 1v1 match

1. \`configure_realtime({ operation:'set_feature', feature:{ id:'matchmaking', kind:'events', label:'Matchmaking', topic:'mm', events:[{name:'queue_join',fields:[{name:'player_id',type:'player_id'}]},{name:'match_found',fields:[{name:'match_id',type:'string'},{name:'players',type:'json'}]}] } })\`
2. \`configure_realtime({ operation:'set_feature', feature:{ id:'match', kind:'state', label:'Match state', topic:'match', fields:[{name:'tower_hp',type:'json'},{name:'units',type:'json'},{name:'elixir',type:'json'}], tickHz:10 } })\`

### Rules
- NEVER write realtime client code without a matching manifest entry — the user's Studio panel goes blind otherwise.
- Feature \`id\` is kebab-case, stable — reuse it if updating.
- Prefer many small features over one giant 'custom' — the Studio renders meaningful widgets for typed kinds.
- Don't fake data in \`axiom.channel\` topics; always match what configure_realtime declared.`;
}
