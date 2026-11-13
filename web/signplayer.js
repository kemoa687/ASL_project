// Text -> sign: draws each letter's average hand pose (taken from YOUR training
// data) as a skeleton hand, one letter at a time.

const FINGERS = [
  { color: "#e8590c", bones: [[0, 1], [1, 2], [2, 3], [3, 4]] }, // thumb
  { color: "#2f9e44", bones: [[0, 5], [5, 6], [6, 7], [7, 8]] }, // index
  { color: "#1971c2", bones: [[9, 10], [10, 11], [11, 12]] }, // middle
  { color: "#9c36b5", bones: [[13, 14], [14, 15], [15, 16]] }, // ring
  { color: "#c2255c", bones: [[17, 18], [18, 19], [19, 20]] }, // little
];
const PALM = [[5, 9], [9, 13], [13, 17], [0, 17]];
const PALM_OUTLINE = [0, 1, 5, 9, 13, 17];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SignPlayer {
  constructor(canvas, means) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.means = means || {};
    this.runId = 0;
  }

  has(ch) {
    return Boolean(this.means[ch.toUpperCase()]);
  }

  /** Characters that will be shown: letters/digits and single spaces between words. */
  static items(text) {
    return [...text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()];
  }

  clear() {
    const { ctx, canvas } = this;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--stage").trim() || "#10201e";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  draw(ch, { flip = false } = {}) {
    this.clear();
    const m = this.means[ch.toUpperCase()];
    if (!m) return;
    const { ctx, canvas } = this;
    const pts = Array.from({ length: 21 }, (_, i) => [m[i * 3], m[i * 3 + 1]]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = canvas.width * 0.14;
    const k = Math.min((canvas.width - 2 * pad) / (maxX - minX || 1), (canvas.height - 2 * pad) / (maxY - minY || 1));
    const ox = (canvas.width - (maxX - minX) * k) / 2 - minX * k;
    const oy = (canvas.height - (maxY - minY) * k) / 2 - minY * k;
    const P = pts.map(([x, y]) => {
      const px = x * k + ox;
      return [flip ? canvas.width - px : px, y * k + oy];
    });

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // palm
    ctx.beginPath();
    PALM_OUTLINE.forEach((i, n) => (n ? ctx.lineTo(...P[i]) : ctx.moveTo(...P[i])));
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = canvas.width * 0.022;
    for (const [a, b] of PALM) {
      ctx.beginPath();
      ctx.moveTo(...P[a]);
      ctx.lineTo(...P[b]);
      ctx.stroke();
    }
    // fingers
    for (const f of FINGERS) {
      ctx.strokeStyle = f.color;
      ctx.lineWidth = canvas.width * 0.03;
      for (const [a, b] of f.bones) {
        ctx.beginPath();
        ctx.moveTo(...P[a]);
        ctx.lineTo(...P[b]);
        ctx.stroke();
      }
    }
    // joints
    ctx.fillStyle = "#fff";
    for (const [x, y] of P) {
      ctx.beginPath();
      ctx.arc(x, y, canvas.width * 0.014, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  stop() {
    this.runId++;
    this.clear();
  }

  /**
   * Plays the text. onStep(index, char) is called before each item and
   * onStep(-1) when finished. Resolves true when it ran to the end.
   */
  async play(text, { speed = 1, flip = false, onStep = () => {} } = {}) {
    const id = ++this.runId;
    const items = SignPlayer.items(text);
    for (let i = 0; i < items.length; i++) {
      if (id !== this.runId) return false;
      const ch = items[i];
      onStep(i, ch);
      if (ch === " ") {
        this.clear();
        await sleep(550 / speed);
      } else {
        this.draw(ch, { flip });
        await sleep(900 / speed);
        this.clear(); // short blink so a repeated letter (LL) is visible
        await sleep(130 / speed);
      }
    }
    if (id !== this.runId) return false;
    onStep(-1, "");
    return true;
  }
}
