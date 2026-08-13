// Central registry of slash commands.
// To add a command: drop a file in src/commands/ (exporting `data` + `execute`)
// and add it to `commandModules` below. Both the runtime collection in
// src/index.js and the deployer in src/deploy-commands.js read from here,
// so there is only one place to keep in sync.
import * as askCmd from './ask.js';
import * as chatCmd from './chat.js';
import * as summarizeCmd from './summarize.js';
import * as helpCmd from './help.js';
import * as adminCmd from './admin.js';
import * as pingCmd from './ping.js';
import * as weatherCmd from './weather.js';
import * as inviteCmd from './invite.js';
import * as reactionroleCmd from './reactionrole.js';

export const commandModules = [
  askCmd,
  chatCmd,
  summarizeCmd,
  helpCmd,
  adminCmd,
  pingCmd,
  weatherCmd,
  inviteCmd,
  reactionroleCmd,
];

export const commandData = commandModules.map((cmd) => cmd.data.toJSON());
