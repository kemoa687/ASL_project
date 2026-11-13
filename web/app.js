import { Classifier, normalizeLandmarks } from "./classifier.js";
import { Speller, formatSentence } from "./speller.js";
import { SignPlayer } from "./signplayer.js";
import { createTracker, HAND_CONNECTIONS } from "./tracker.js";

const $ = (id) => document.getElementById(id);

// Letter acceptance is time-based, so it behaves the same on slow phones and fast laptops:
// a letter must win a majority of the last few frames AND stay the same for HOLD_MS.
const WINDOW = 10; // frames used for smoothing
const MAJORITY = 6; // frames (of WINDOW) that must agree
const MIN_CONF = 0.7;
const HOLD_MS = 450; // hold a new letter this long to type it
const REPEAT_MS = 1500; // keep holding the same letter this long to type it again (LL)
const LOST_MS = 500; // hand out of view this long = start fresh
const WOBBLE_MS = 250; // no clear letter for this long = the hold was interrupted

let clf = null;
let speller = null;
let tracker = null;
let player = null;

// ---------------------------------------------------------------- helpers
let bannerTimer = 0;
function showBanner(msg, ms = 0) {
  const b = $("banner");
  b.textContent = msg;
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => (b.hidden = true), ms);
}
function addBanner(msg) {
  const b = $("banner");
  showBanner(b.hidden ? msg : `${b.textContent} ${msg}`);
}
const setNote = (msg) => ($("fixNote").textContent = msg);
const DEFAULT_NOTE = "Checks spelling only. Always read the sentence before speaking it.";

// ---------------------------------------------------------------- camera + recognition
const video = document.createElement("video");
video.setAttribute("playsinline", "");
video.muted = true;
video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
document.body.appendChild(video);

const canvas = $("view");
const ctx = canvas.getContext("2d");
let stream = null;
let running = false;
let facing = "user";
let lastFrame = 0;
let rafId = 0;

let win = [];
let candidate = null; // the letter currently being held
let candidateSince = 0;
let lastAccepted = null; // the letter most recently typed, while it is still being held
let unstableSince = 0;
let lastSeen = 0;

const SYMBOLS = { space: "␣", del: "⌫", nothing: "–" };
const shown = (label) => (label ? SYMBOLS[label] || label.toUpperCase() : "–");

function setHud(label, progress) {
  $("hudLetter").textContent = shown(label);
  $("hudFill").style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showBanner("The camera needs a secure page: use https:// (or http://localhost on this computer).");
    return;
  }
  $("btnCam").disabled = true;
  try {
    if (!tracker) {
      $("stageMsg").textContent = "Loading hand tracker…";
      try {
        tracker = await createTracker();
      } catch (e) {
        console.error(e);
        showBanner("Could not load the hand tracker. Check your internet connection (it is downloaded from a CDN the first time).");
        $("stageMsg").textContent = "Hand tracker failed to load";
        return;
      }
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    $("stageMsg").hidden = true;
    $("btnCam").textContent = "Stop camera";
    running = true;
    win = [];
    lastAccepted = null;
    loop();
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      $("btnSwitch").hidden = cams.length < 2;
    } catch (_) { /* optional */ }
  } catch (e) {
    console.error(e);
    const msg =
      e.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access for this site and try again."
      : e.name === "NotFoundError" ? "No camera was found on this device."
      : e.name === "NotReadableError" ? "The camera is in use by another app."
      : `Could not start the camera (${e.name || e.message}).`;
    showBanner(msg, 8000);
    stopCamera();
  } finally {
    $("btnCam").disabled = false;
  }
}

function stopCamera() {
  running = false;
  cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("stageMsg").textContent = "Camera is off";
  $("stageMsg").hidden = false;
  $("btnCam").textContent = "Start camera";
  setHud(null, 0);
}

function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  if (video.readyState < 2) return;
  const now = performance.now();
  if (now - lastFrame < 30) return; // about 30 frames per second is plenty
  lastFrame = now;

  ctx.save();
  if ($("chkMirror").checked) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  // Detect on the same (possibly mirrored) picture the user sees, like realtime.py does
  const lms = tracker.detect(canvas, now);
  if (!lms) return onNoHand(now);
  drawHand(lms);
  if (clf) onPrediction(clf.predict(normalizeLandmarks(lms, canvas.width, canvas.height)), now);
}

function drawHand(lms) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.lineWidth = Math.max(2, w / 200);
  ctx.strokeStyle = "#2dd4bf";
  ctx.lineCap = "round";
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(lms[a].x * w, lms[a].y * h);
    ctx.lineTo(lms[b].x * w, lms[b].y * h);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const p of lms) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, Math.max(2, w / 220), 0, Math.PI * 2);
    ctx.fill();
  }
}

function onNoHand(now) {
  win = [];
  candidate = null;
  unstableSince = 0;
  if (now - lastSeen > LOST_MS) lastAccepted = null;
  setHud(null, 0);
}

function onPrediction(pred, now) {
  lastSeen = now;
  win.push(pred.conf >= MIN_CONF ? pred.label : null);
  if (win.length > WINDOW) win.shift();

  const counts = new Map();
  for (const l of win) if (l) counts.set(l, (counts.get(l) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [l, k] of counts) if (k > n) { best = l; n = k; }

  if (!best || n < MAJORITY) {
    // no clear letter right now (hand moving between letters, or unsure)
    if (!unstableSince) unstableSince = now;
    if (now - unstableSince > WOBBLE_MS) {
      if (candidate === lastAccepted) lastAccepted = null; // the hold was broken
      candidate = null;
    }
    return setHud(candidate, 0);
  }
  unstableSince = 0;

  if (best !== candidate) {
    if (candidate === lastAccepted) lastAccepted = null; // moved on from the typed letter
    candidate = best;
    candidateSince = now;
  }
  const required = best === lastAccepted ? REPEAT_MS : HOLD_MS;
  const held = now - candidateSince;
  setHud(best, held / required);

  if (held >= required) {
    accept(best);
    lastAccepted = best;
    candidateSince = now; // a repeat needs REPEAT_MS from now
  }
}

// ---------------------------------------------------------------- sentence editing
const sentence = $("sentence");
let undoText = null;

function accept(label) {
  if (label === "nothing") return;
  if (navigator.vibrate) navigator.vibrate(25);
  if (label === "space") {
    if (sentence.value && !sentence.value.endsWith(" ")) sentence.value += " ";
  } else if (label === "del") {
    sentence.value = sentence.value.slice(0, -1);
  } else {
    sentence.value += label.toLowerCase();
  }
  renderFixes();
}

function renderFixes() {
  const box = $("fixes");
  box.replaceChildren();
  if (!speller) return;
  const text = sentence.value;
  // skip the last word while it is still being signed
  const bad = speller.analyze(text).filter((t) => !t.ok && t.end < text.length).slice(0, 5);
  for (const t of bad) {
    const row = document.createElement("div");
    row.className = "fix";
    const word = document.createElement("span");
    word.className = "bad";
    word.textContent = t.raw;
    row.append(word);
    for (const s of t.suggestions.slice(0, 4)) {
      const b = document.createElement("button");
      b.textContent = s.word;
      b.addEventListener("click", () => {
        if (sentence.value.slice(t.start, t.end) !== t.raw) return renderFixes();
        sentence.value = sentence.value.slice(0, t.start) + s.word + sentence.value.slice(t.end);
        renderFixes();
      });
      row.append(b);
    }
    const keep = document.createElement("button");
    keep.className = "keep";
    keep.textContent = "Keep as is";
    keep.title = `Remember "${t.raw}" as a correct word (for names, etc.)`;
    keep.addEventListener("click", () => {
      speller.addCustom(t.raw);
      renderFixes();
    });
    row.append(keep);
    $("fixes").append(row);
  }
}

/** Applies clear corrections and formatting. Returns the words it was NOT sure about. */
function fixAll() {
  const before = sentence.value;
  if (!before.trim()) return [];
  let text = before;
  let changes = [];
  let unresolved = [];
  if (speller) {
    const r = speller.autoFix(before);
    text = r.text;
    changes = r.changes;
    unresolved = r.unresolved;
  }
  text = formatSentence(text);
  if (text !== before) {
    undoText = before;
    sentence.value = text;
    $("btnUndo").disabled = false;
  }
  let msg = changes.length ? `Changed: ${changes.map((c) => `${c.from} → ${c.to}`).join(", ")}.` : "No spelling changes.";
  if (unresolved.length) msg += ` Please check: ${unresolved.join(", ")}.`;
  setNote(msg);
  renderFixes();
  return unresolved;
}

function setupSentence() {
  sentence.addEventListener("input", renderFixes);
  $("btnSpace").addEventListener("click", () => {
    if (sentence.value && !sentence.value.endsWith(" ")) sentence.value += " ";
    renderFixes();
  });
  $("btnBack").addEventListener("click", () => {
    sentence.value = sentence.value.slice(0, -1);
    renderFixes();
  });
  $("btnClear").addEventListener("click", () => {
    if (sentence.value) {
      undoText = sentence.value;
      $("btnUndo").disabled = false;
    }
    sentence.value = "";
    setNote(DEFAULT_NOTE);
    renderFixes();
  });
  $("btnFix").addEventListener("click", fixAll);
  $("btnUndo").addEventListener("click", () => {
    if (undoText === null) return;
    sentence.value = undoText;
    undoText = null;
    $("btnUndo").disabled = true;
    setNote(DEFAULT_NOTE);
    renderFixes();
  });
}

// ---------------------------------------------------------------- speech out
function loadVoices() {
  const sel = $("voice");
  sel.replaceChildren();
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  if (!voices.length) {
    sel.append(new Option("Default voice", ""));
    return;
  }
  for (const v of voices) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
}

let warnedText = null; // the text we already warned about, so a second press speaks it

function speak() {
  if (!("speechSynthesis" in window)) return showBanner("This browser cannot read text aloud.", 6000);
  if (!sentence.value.trim()) return;
  if ($("chkAutoFix").checked) {
    const unsure = fixAll();
    if (unsure.length && warnedText !== sentence.value) {
      // Do not speak a possible mistake without the user knowing
      warnedText = sentence.value;
      setNote(`Not sure about: ${unsure.join(", ")}. Pick a spelling above, or press Speak again to say it as written.`);
      return;
    }
  }
  const text = sentence.value.trim();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = Number($("rate").value);
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === $("voice").value);
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- text -> sign
function buildStrip(items) {
  const strip = $("signStrip");
  strip.replaceChildren();
  for (const ch of items) {
    const s = document.createElement("span");
    if (ch === " ") s.className = "gap";
    s.textContent = ch === " " ? " " : ch;
    strip.append(s);
  }
}

async function playSign() {
  const text = $("signInput").value;
  const items = SignPlayer.items(text);
  if (!items.length) return;
  if (!clf) showBanner("Signs need model.json. Run python export_model.py in your project folder, then reload.", 8000);
  buildStrip(items);
  const spans = [...$("signStrip").children];
  await player.play(text, {
    speed: Number($("signSpeed").value),
    flip: $("chkFlip").checked,
    onStep: (i, ch) => {
      spans.forEach((s, k) => s.classList.toggle("on", k === i));
      $("signLetter").textContent = ch === " " ? "" : ch.toUpperCase();
    },
  });
  $("signLetter").textContent = "";
}

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const btn = $("btnMic");
  btn.hidden = false;
  btn.addEventListener("click", () => {
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    btn.disabled = true;
    btn.textContent = "Listening…";
    rec.onresult = (e) => {
      $("signInput").value = e.results[0][0].transcript;
      playSign();
    };
    rec.onerror = (e) => {
      const msg = e.error === "not-allowed" ? "Microphone permission was denied." : `Could not hear you (${e.error}).`;
      showBanner(msg, 6000);
    };
    rec.onend = () => {
      btn.disabled = false;
      btn.textContent = "Speak instead";
    };
    try {
      rec.start();
    } catch (_) {
      rec.onend();
    }
  });
}

// ---------------------------------------------------------------- tabs + wiring
function setTab(name) {
  const sign = name === "sign";
  $("panelSign").hidden = !sign;
  $("panelText").hidden = sign;
  $("tabSign").setAttribute("aria-selected", String(sign));
  $("tabText").setAttribute("aria-selected", String(!sign));
  if (sign) {
    player.stop();
  } else {
    stopCamera(); // saves battery and keeps the camera off when not needed
  }
}

function wireUI() {
  $("tabSign").addEventListener("click", () => setTab("sign"));
  $("tabText").addEventListener("click", () => setTab("text"));
  $("btnCam").addEventListener("click", () => (running ? stopCamera() : startCamera()));
  $("btnSwitch").addEventListener("click", async () => {
    facing = facing === "user" ? "environment" : "user";
    $("chkMirror").checked = facing === "user";
    stopCamera();
    await startCamera();
  });
  $("btnSpeak").addEventListener("click", speak);
  $("btnStop").addEventListener("click", () => "speechSynthesis" in window && speechSynthesis.cancel());
  $("btnPlay").addEventListener("click", playSign);
  $("btnSignStop").addEventListener("click", () => {
    player.stop();
    $("signLetter").textContent = "";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
  });
  setupSentence();
  setupMic();
  if ("speechSynthesis" in window) {
    loadVoices();
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }
}

async function init() {
  player = new SignPlayer($("signCanvas"), {});
  player.clear();
  wireUI();
  if (location.protocol === "file:") return; // the page already explains this

  try {
    clf = await Classifier.load("model.json");
    player = new SignPlayer($("signCanvas"), clf.means);
    player.clear();
  } catch (e) {
    console.error(e);
    addBanner("model.json was not found. In your project folder run: python export_model.py (it creates web/model.json), then reload this page.");
  }
  try {
    const res = await fetch("words.txt");
    if (!res.ok) throw new Error(res.status);
    speller = new Speller((await res.text()).split("\n").filter(Boolean));
  } catch (e) {
    console.error(e);
    addBanner("words.txt could not be loaded, so spelling correction is off.");
  }
  renderFixes();
}

init();
