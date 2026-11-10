// [PLAY PASS - STICKERS] The 24 chat stickers. A chat message can carry one
// sticker id; the server only accepts ids from this list and only from
// players who have Play Pass. The label is what bots "see" in chat.
const STICKERS = {
  "angry": "angry", "nervous": "nervous", "facepalm": "facepalm", "shh": "Shh!", "sus": "SUS!", "smug": "smug",
  "not-me": "Not me!", "im-crewmate": "I'm Crewmate!", "im-saboteur": "I'm Saboteur!", "i-saw-you": "I saw you!", "follow-me": "Follow me!", "wait": "Wait!",
  "where": "Where?", "doing-tasks": "Doing tasks!", "task-done": "Task done!", "fixing": "Fixing...", "check-cams": "Check cams!", "sabotage": "Sabotage!",
  "vote": "Vote!", "skip": "Skip!", "discuss": "Discuss!", "trust-me": "Trust me!", "run": "Run!", "im-ghost": "I'm Ghost!",
};
function validateSticker(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(STICKERS, id) ? id : null;
}
function stickerLabel(id) { return STICKERS[id] ? `[sticker: ${STICKERS[id]}]` : ""; }
module.exports = { STICKERS, validateSticker, stickerLabel };
