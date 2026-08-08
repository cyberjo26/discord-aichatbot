## Goal
Stop draining TTS rate limit when user not in voice channel. Skip condense AI call + TTS synthesis entirely when user has no active voice channel.

## Root Cause
Two call sites call `condenseForVoice` (AI) + `synthesize` (TTS) **before** checking whether the user is in a voice channel. When not in voice, the synthesized MP3 is sent as a file attachment — wasted TTS rate limit for an audio the user rarely wanted.

## Scope (2 files)
1. `src/utils/voice-response.js` — `handleVoiceResponse` (used by `ask.js`, `chat.js`, `mention-handler.js`)
2. `src/prefix-handler.js` — `handleVoiceReply`

## Out of scope (already correct)
- `src/utils/reminders.js:254-273` — already checks `voiceChannel` before `synthesize`. No change.
- `src/voice/welcome.js` — fires on voice join event, user is in voice by definition.

## Changes

### 1. `src/utils/voice-response.js` — `handleVoiceResponse`
Reorder so voice channel check happens **first**. If no voice channel: return early (`false`), skip `condenseForVoice` + `synthesize`. Drop the MP3 file-attachment fallback branch (it was the rate-limit drain).

```
export async function handleVoiceResponse(member, text, interaction = null, replyOptions = null) {
  const voiceChannel = getMemberVoiceChannel(member);

  // User not in voice channel → skip TTS entirely (preserve rate limit).
  // Caller already sent / will send the text reply.
  if (!voiceChannel) {
    return false;
  }

  const voiceText = await condenseForVoice(text);
  const audioBuffer = await synthesize(voiceText);

  if (interaction && replyOptions) {
    await interaction.editReply(replyOptions);
  }
  await playInVoiceChannel(voiceChannel, audioBuffer);
  return true;
}
```

`AttachmentBuilder` import becomes unused → remove it to keep the file clean.

### 2. `src/prefix-handler.js` — `handleVoiceReply`
Same reorder. Check voice channel first; if absent, return early without synthesizing. Drop the MP3 file-attachment fallback.

```
async function handleVoiceReply(message, answer, replyOptions) {
  try {
    const voiceChannel = getMemberVoiceChannel(message.member);
    if (!voiceChannel) {
      // Not in voice → skip TTS to preserve rate limit. Text reply proceeds normally.
      return;
    }

    const voiceText = await condenseForVoice(answer);
    const audioBuffer = await synthesize(voiceText);

    // Play after message is sent
    setTimeout(async () => {
      try {
        await playInVoiceChannel(voiceChannel, audioBuffer);
      } catch (err) {
        logger.error(`Voice play error: ${err.message}`);
      }
    }, 500);
  } catch (err) {
    logger.error(`Voice error: ${err.message}`);
    replyOptions.content = '⚠️ *Voice gagal.*';
  }
}
```

`AttachmentBuilder` import in prefix-handler.js: verify still used elsewhere before removing.

## Caller safety (verified)
- `ask.js` / `chat.js`: `handleVoiceResponse` wrapped in try/catch, fallback `interaction.editReply(replyOptions)` runs after → text reply still sent when TTS skipped.
- `prefix-handler.js`: `handleVoiceReply` runs before `message.reply(replyOptions)` → text reply still sent.
- `mention-handler.js:816`: text already sent separately before voice call → unaffected.

## Verification
- User in voice → TTS plays (unchanged behavior).
- User NOT in voice → no AI condense call, no TTS API hit, text reply only, no MP3 attachment.
- `node --check` both files after edit.
- Run `src/test-voice-features.js` if it covers voice-response paths.