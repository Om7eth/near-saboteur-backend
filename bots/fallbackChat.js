// ============================================================
// [AI BOTS - NEAR HACKATHON] Rule-based meeting chat (no AI needed).
//
// Used when NEAR AI Cloud is not configured, over budget, slow or
// failing. Goals: sound like a casual player, answer what was actually
// asked, give reasons (who was seen where), and NEVER repeat a line in
// the same meeting.
//
// Intents understood (English / Hinglish / Hindi keywords):
//   accuse  - "<bot> sus / killed / liar / vote <bot>"  -> defend with alibi
//   where   - "where were you / kahan the"               -> alibi
//   who     - "any sus / who / kisne dekha / kaun"         -> share what you saw
//   defend  - "but X reported / X was with me"             -> reconsider
//   skip    - "skip?"                                       -> agree or object
// ============================================================

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;

const RX = {
  accuse: /\b(sus|suspicious|kill(ed|er)?|liar|lying|jhooth|jhoota|maara|mara|vote(\s+out)?|impostor|saboteur|sabo)\b|संदिग्ध|मारा|झूठ/i,
  where: /\b(where|kahan|kaha|kidhar|location)\b|कहाँ|कहां/i,
  who: /\b(any ?sus|who|kisne|kaun|kon|dekha|seen|saw|info|anyone)\b|किसने|कौन|देखा/i,
  defend: /\b(but|par|lekin|magar|reported|report kiya|was with|saath|innocent|clear|safe)\b|लेकिन|साथ/i,
  skip: /\bskip\b|स्किप/i,
};

// "any sus?", "kaun sus hai", "who did it" are QUESTIONS, not accusations.
const ASKING = /\bany ?(sus|info|one)\b|\bwho\b|\bkaun\b|\bkon\b|\bkisne\b|\bkisko\b|कौन|किसने/i;
function classify(text, botName) {
  const t = (text || "").toLowerCase();
  const named = botName && t.includes(botName.toLowerCase());
  if (RX.skip.test(t) && t.length < 30) return "skip";
  if (RX.where.test(t)) return "where";
  if (ASKING.test(t)) return "who";
  if (named && RX.accuse.test(t)) return "accuse";
  if (RX.defend.test(t)) return "defend";
  if (RX.who.test(t) || /\?$/.test(t.trim())) return "who";
  return named ? "who" : "other";
}
// A living player (other than me) the message is about, if any.
function mentionedOther(text, aliveNames, me) {
  const t = (text || "").toLowerCase();
  for (const n of aliveNames) if (n !== me && t.includes(n.toLowerCase())) return n;
  return null;
}

// Variants per intent, per language. Every call picks one not yet said.
const T = {
  english: {
    sawKill: (k, v, w, cam) => [`${cam ? "on cams i" : "i"} literally saw ${k} kill ${v} in ${w}`, `it's ${k}. saw them kill ${v} in ${w}${cam ? " on the cameras" : ""}`, `${k} killed ${v}, i was right there in ${w}`],
    body: (v, w) => [`found ${v} dead in ${w}`, `${v}'s body is in ${w}`, `just found ${v} in ${w}, rip`],
    near: (who, w) => [`${who} was around ${w} right before`, `last person i saw near ${w} was ${who}`, `${who} was in ${w} not long before that`],
    noNear: (w) => [`didn't see anyone near ${w} tho`, `no clue who was in ${w}`],
    alibi: (w, act) => [`i was in ${w} ${act}`, `${w}, ${act}. check if you want`, `was ${act} in ${w} the whole time`],
    alibiWith: (w, act, x) => [`i was in ${w} ${act}, ${x} saw me`, `ask ${x}, we were both in ${w}`],
    deny: () => ["wasn't me", "nah not me", "why me lol"],
    sighting: (x, w) => [`saw ${x} in ${w} a bit ago`, `${x} was hanging around ${w}`, `i only saw ${x}, in ${w}`],
    nothing: () => ["didn't see anything tbh", "no info from me, was doing tasks", "no idea, anyone else?"],
    ask: () => ["where was everyone?", "who was near there?", "anyone have info?"],
    doubt: (x, why) => [`${x} ${why} tho`, `kinda sus that ${x} ${why}`],
    concede: (x) => [`ok fair, ${x} might be clear`, `true, i'm not sure about ${x} then`],
    hold: (x) => [`reporting doesn't clear ${x} tho`, `still not sure about ${x}`],
    skipYes: () => ["yeah skip, no info", "skip for now", "ok skip"],
    skipNo: (x) => [`no don't skip, vote ${x}`, `wait, i think it's ${x}`],
  },
  hinglish: {
    sawKill: (k, v, w, cam) => [`${cam ? "camera pe" : "maine"} khud dekha ${k} ne ${v} ko ${w} mein maara`, `${k} hai bhai, ${w} mein ${v} ko maarte dekha${cam ? " camera pe" : ""}`, `${k} ne maara ${v} ko, main wahin ${w} mein tha`],
    body: (v, w) => [`${v} ki body ${w} mein mili`, `${w} mein ${v} mara pada hai`, `abhi ${w} mein ${v} ki body dekhi`],
    near: (who, w) => [`${who} thodi der pehle ${w} ke paas tha`, `${w} ke paas last maine ${who} ko dekha tha`, `${who} ${w} mein ghoom raha tha usse pehle`],
    noNear: (w) => [`par ${w} ke paas kisi ko nahi dekha`, `pata nahi ${w} mein kaun tha`],
    alibi: (w, act) => [`main ${w} mein tha, ${act}`, `${w} mein tha bhai, ${act}`, `poora time ${w} mein ${act}`],
    alibiWith: (w, act, x) => [`main ${w} mein tha, ${x} ne dekha mujhe`, `${x} se pucho, hum dono ${w} mein the`],
    deny: () => ["main nahi hoon bhai", "mujhe kyu bol rahe ho", "nahi yaar main nahi"],
    sighting: (x, w) => [`maine ${x} ko ${w} mein dekha tha`, `${x} ${w} ke aas paas tha`, `sirf ${x} dikha tha, ${w} mein`],
    nothing: () => ["maine kuch nahi dekha", "mere paas koi info nahi, tasks kar raha tha", "pata nahi yaar, kisi aur ne dekha?"],
    ask: () => ["sab log kahan the?", "wahan kaun tha?", "kisi ke paas info hai?"],
    doubt: (x, why) => [`${x} ${why} yaar`, `${x} thoda sus hai, ${why}`],
    concede: (x) => [`haan theek hai, ${x} shayad clear hai`, `sahi baat, ${x} pe pakka nahi`],
    hold: (x) => [`report karne se ${x} clear nahi hota`, `${x} pe abhi bhi doubt hai`],
    skipYes: () => ["haan skip karo, info nahi hai", "abhi skip", "ok skip"],
    skipNo: (x) => [`skip mat karo, ${x} ko vote karo`, `ruko, mujhe lagta hai ${x} hai`],
  },
  hindi: {
    sawKill: (k, v, w, cam) => [`${cam ? "कैमरे पर" : "मैंने"} देखा ${k} ने ${v} को ${w} में मारा`, `${k} है, ${w} में ${v} को मारते देखा`],
    body: (v, w) => [`${v} की बॉडी ${w} में मिली`, `${w} में ${v} मरा पड़ा है`],
    near: (who, w) => [`${who} थोड़ी देर पहले ${w} के पास था`, `${w} के पास आखिरी बार ${who} दिखा था`],
    noNear: (w) => [`पर ${w} के पास कोई नहीं दिखा`],
    alibi: (w, act) => [`मैं ${w} में था`, `मैं पूरे समय ${w} में था`],
    alibiWith: (w, act, x) => [`मैं ${w} में था, ${x} ने मुझे देखा`],
    deny: () => ["मैं नहीं हूँ", "मुझे क्यों बोल रहे हो"],
    sighting: (x, w) => [`मैंने ${x} को ${w} में देखा था`, `${x} ${w} के आसपास था`],
    nothing: () => ["मैंने कुछ नहीं देखा", "मेरे पास कोई जानकारी नहीं"],
    ask: () => ["सब लोग कहाँ थे?", "वहाँ कौन था?"],
    doubt: (x, why) => [`${x} थोड़ा संदिग्ध है`],
    concede: (x) => [`ठीक है, ${x} शायद सही है`],
    hold: (x) => [`${x} पर अभी भी शक है`],
    skipYes: () => ["हाँ स्किप करो", "अभी स्किप"],
    skipNo: (x) => [`स्किप मत करो, ${x} को वोट करो`],
  },
};

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
function fresh(variants, used) {
  const left = variants.filter((v) => !used.has(norm(v)));
  return left.length ? pick(left) : "";
}

// --- facts from memory -------------------------------------------------
function lastActivity(memory, lang) {
  const d = [...memory].reverse().find((m) => m.kind === "did");
  if (!d) return null;
  return { where: d.where, act: (lang === "english" ? d.en : d.hi) || (lang === "english" ? `doing ${d.what}` : `${d.what} kar raha tha`), t: d.t };
}
function companionAt(memory, where, t, aliveNames, me) {
  const s = memory.filter((m) => m.kind === "saw" && m.via === "eyes" && m.where === where && Math.abs(m.t - t) < 25000 && aliveNames.has(m.name) && m.name !== me);
  return s.length ? s[s.length - 1].name : null;
}
function nearBody(memory, body, aliveNames, me) {
  const s = memory.filter((m) => m.kind === "saw" && m.where === body.where && m.t <= body.t && body.t - m.t < 45000 && aliveNames.has(m.name) && m.name !== me);
  return s.length ? s[s.length - 1].name : null;
}
function recentSighting(memory, aliveNames, me, exclude) {
  const s = [...memory].reverse().find((m) => m.kind === "saw" && aliveNames.has(m.name) && m.name !== me && m.name !== exclude);
  return s ? { name: s.name, where: s.where } : null;
}

// ctx: from meetingBrain.buildContext. trigger: { text, fromName } of the
// message that prompted this, or null (opening / chiming in).
// used: Set of normalized lines already said in this meeting (any bot).
function respond(ctx, memory, ownSaid, trigger, used) {
  const lang = ctx.language in T ? ctx.language : "english";
  const L = T[lang];
  const me = ctx.me.name;
  const aliveNames = new Set(ctx.alive.map(([, p]) => p.name));
  const others = ctx.alive.filter(([, p]) => p !== ctx.me).map(([, p]) => p.name);
  const intent = trigger ? classify(trigger.text, me) : "open";
  const aboutOther = trigger && !trigger.text.toLowerCase().includes(me.toLowerCase()) ? mentionedOther(trigger.text, aliveNames, me) : null;
  const act = lastActivity(memory, lang);
  const body = [...memory].reverse().find((m) => m.kind === "body");
  const say = (variants) => fresh(variants, used);
  const alibi = () => {
    if (!act) return say(L.deny());
    const w = companionAt(memory, act.where, act.t, aliveNames, me);
    return say(w && chance(0.6) ? L.alibiWith(act.where, act.act, w) : L.alibi(act.where, act.act));
  };

  if (ctx.isSab) {
    const crew = ctx.alive.filter(([, p]) => p !== ctx.me && p.role !== "saboteur").map(([, p]) => p.name);
    // Who are the humans already pointing at? Pile on, with a reason.
    const accused = crew.find((n) => ctx.humanTexts.some((t) => t.toLowerCase().includes(n.toLowerCase()) && RX.accuse.test(t)));
    const seenSomeone = recentSighting(memory, aliveNames, me, null);
    const target = accused || (seenSomeone && crew.includes(seenSomeone.name) ? seenSomeone.name : null);
    let line = "";
    if ((intent === "accuse" || intent === "where") && aboutOther) line = aboutOther === target && chance(0.5) ? say(L.hold(target)) : "";
    else if (intent === "accuse" || intent === "where") line = alibi();
    else if (intent === "skip") line = target && chance(0.4) ? say(L.skipNo(target)) : say(L.skipYes());
    else if (intent === "defend" && trigger && target && trigger.text.toLowerCase().includes(target.toLowerCase())) line = say(chance(0.5) ? L.hold(target) : L.concede(target));
    else if (intent === "who" || intent === "open" || intent === "other") {
      if (target && seenSomeone && seenSomeone.name === target && chance(0.6)) line = say(L.sighting(target, seenSomeone.where));
      else if (!ownSaid.length && act && chance(0.5)) line = alibi();
      else if (chance(0.5)) line = say(L.ask());
    }
    return { say: line, vote: target && chance(0.75) ? target : "skip" };
  }

  // --- crew ---
  const kill = [...memory].reverse().find((m) => m.kind === "kill" && aliveNames.has(m.name));
  if (kill) {
    if (intent === "accuse" || intent === "where") return { say: alibi() || say(L.sawKill(kill.name, kill.victim, kill.where, kill.via === "camera")), vote: kill.name };
    if (intent === "skip") return { say: say(L.skipNo(kill.name)), vote: kill.name };
    return { say: say(L.sawKill(kill.name, kill.victim, kill.where, kill.via === "camera")), vote: kill.name };
  }
  const suspect = body ? nearBody(memory, body, aliveNames, me) : null;
  if (intent === "open") {
    if (body) {
      const first = say(L.body(body.name, body.where));
      const second = suspect ? say(L.near(suspect, body.where)) : say(L.noNear(body.where));
      return { say: [first, second].filter(Boolean).join(", "), vote: suspect || "skip" };
    }
    const s = recentSighting(memory, aliveNames, me, null);
    if (s && chance(0.5)) return { say: say(L.sighting(s.name, s.where)), vote: "skip" };
    return { say: chance(0.6) ? say(L.ask()) : "", vote: "skip" };
  }
  if ((intent === "accuse" || intent === "where") && aboutOther) {
    const s = [...memory].reverse().find((m) => m.kind === "saw" && m.name === aboutOther);
    return { say: s ? say(L.sighting(aboutOther, s.where)) : "", vote: suspect || "skip" };
  }
  if (intent === "accuse" || intent === "where") return { say: alibi(), vote: suspect || "skip" };
  if (intent === "skip") return { say: suspect && chance(0.5) ? say(L.skipNo(suspect)) : say(L.skipYes()), vote: suspect && chance(0.5) ? suspect : "skip" };
  if (intent === "defend" && suspect && trigger.text.toLowerCase().includes(suspect.toLowerCase())) {
    // Someone vouched for our suspect: a fair crewmate softens.
    return { say: say(L.concede(suspect)), vote: "skip" };
  }
  if (intent === "who" || intent === "other") {
    if (suspect && body) return { say: say(L.near(suspect, body.where)), vote: suspect };
    const s = recentSighting(memory, aliveNames, me, null);
    if (s) return { say: say(L.sighting(s.name, s.where)), vote: "skip" };
    return { say: say(L.nothing()), vote: "skip" };
  }
  return { say: "", vote: suspect || "skip" };
}

module.exports = { respond, classify, norm };
