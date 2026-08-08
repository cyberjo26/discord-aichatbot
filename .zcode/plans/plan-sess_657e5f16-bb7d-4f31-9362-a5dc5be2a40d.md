## Plan: fix invite permissions

### Problem
Invite link hard-codes `permissions=3230720`, which only grants basic chat + voice. Bot features that need moderation/admin perms stay unavailable after invite.

### What change

1. **Create one permission helper**
   - Add helper in `src/utils/permissions.js` or new small utility near invite code.
   - Build invite permission list from `PermissionFlagsBits` used by current bot features.
   - Keep scope `bot applications.commands`.

2. **Update all invite link builders to use helper**
   - `src/commands/invite.js`
   - `src/actions/utility.js` (prefix `!invite` / `!undang`)
   - If any other invite URL builder exists, point it to same helper.

3. **Permissions to include**
   - Existing chat/voice: `ViewChannel`, `SendMessages`, `EmbedLinks`, `ReadMessageHistory`, `Connect`, `Speak`
   - Moderation/admin in codebase:
     - `ManageMessages` — prune / delete-message flows
     - `ModerateMembers` — timeout
     - `KickMembers` — kick
     - `BanMembers` — ban
     - `ManageChannels` — create/delete channels, VoiceMaster
     - `ManageRoles` — role add/remove
     - `ManageNicknames` — nickname change
     - `MuteMembers` — voice mute
     - `DeafenMembers` — voice deafen
     - `MoveMembers` — voice disconnect / move
     - `MentionEveryone` — announce/broadcast flows
   - Add `UseVAD` only if voice receive path actually needs it. If code only joins + plays TTS, skip it.

4. **Keep invite URL readable**
   - Stop hard-coded decimal bitfield.
   - Generate from permission names so future feature changes need one helper edit.

### Why this path
- One source of truth.
- Fixes slash + prefix invite together.
- Avoids stale decimal math.
- Matches bot's real feature set.

### Verification
- Rebuild invite link, confirm URL contains expanded permission bitfield.
- Spot-check generated invite in Discord OAuth screen.
- Confirm current features map to included permissions.

### Note
Some capabilities may still be impossible if Discord treats them as non-invite grant or if bot lacks server-side role access. Invite link can only request permissions; server role assignment still controls final access.