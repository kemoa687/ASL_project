// Spelling correction tuned for fingerspelling, plus sentence tidy-up.
// It fixes SPELLING only. It cannot know what the signer meant, so the app
// always shows the changes and lets the user choose.

// Letters whose ASL handshapes look alike, so mixing them up is cheaper than a random typo.
const LOOKALIKES = ["aemnst", "uvr", "gh", "ij", "pq"].map((g) => new Set(g));
const lookalike = (a, b) => LOOKALIKES.some((s) => s.has(a) && s.has(b));
const subCost = (a, b) => (a === b ? 0 : lookalike(a, b) ? 0.85 : 1);

/** Weighted Damerau-Levenshtein distance; returns Infinity when it exceeds `limit`. */
function distance(a, b, limit) {
  const n = a.length;
  const m = b.length;
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      // A missing or extra DOUBLED letter (helo/hello) is the commonest fingerspelling slip: cheaper
      const del = i > 1 && a[i - 1] === a[i - 2] ? 0.6 : 1; // typed word has a repeated letter
      const ins = j > 1 && b[j - 1] === b[j - 2] ? 0.6 : 1; // candidate has a repeated letter
      let v = Math.min(prev[j] + del, cur[j - 1] + ins, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // swapped neighbours
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit + 1e-9) return Infinity;
    prev2 = prev;
    prev = cur;
  }
  return prev[m] <= limit + 1e-9 ? prev[m] : Infinity;
}

const maxCost = (len) => (len <= 2 ? 1 : len <= 4 ? 1.2 : 2);

export class Speller {
  /** @param {string[]} words most common first */
  constructor(words) {
    this.words = words;
    this.rank = new Map(words.map((w, i) => [w, i]));
    this.byLen = new Map();
    for (const w of words) {
      if (!this.byLen.has(w.length)) this.byLen.set(w.length, []);
      this.byLen.get(w.length).push(w);
    }
    this.custom = new Set();
    this.cache = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem("signbridge.words") || "[]");
      saved.forEach((w) => this.custom.add(w));
    } catch (_) { /* storage unavailable: personal words just won't persist */ }
  }

  addCustom(word) {
    this.custom.add(word.toLowerCase());
    try {
      localStorage.setItem("signbridge.words", JSON.stringify([...this.custom]));
    } catch (_) { /* ignore */ }
  }

  isWord(w) {
    w = w.toLowerCase();
    return this.rank.has(w) || this.custom.has(w);
  }

  /** Best replacements for a misspelled word: [{ word, cost }], best first. */
  suggest(word, n = 4) {
    const w = word.toLowerCase();
    if (this.isWord(w)) return [];
    if (this.cache.has(w)) return this.cache.get(w).slice(0, n);
    const limit = maxCost(w.length);
    const found = [];
    for (let len = w.length - 2; len <= w.length + 2; len++) {
      for (const cand of this.byLen.get(len) || []) {
        const d = distance(w, cand, limit);
        if (d === Infinity) continue;
        // frequency breaks ties and favours common words (0 = most common, 0.5 = rarest)
        const score = d + 0.5 * (Math.log(this.rank.get(cand) + 2) / Math.log(this.words.length + 2));
        found.push({ word: cand, cost: d, score });
      }
    }
    found.sort((a, b) => a.score - b.score);
    const best = found.slice(0, 4);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(w, best);
    return best.slice(0, n);
  }

  /** Splits text into letter-runs and flags the ones that are not words. */
  analyze(text) {
    const tokens = [];
    const re = /[A-Za-z]+/g;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[0];
      const ok = this.isWord(raw);
      tokens.push({
        raw,
        start: m.index,
        end: m.index + raw.length,
        ok,
        suggestions: ok ? [] : this.suggest(raw),
      });
    }
    return tokens;
  }

  /**
   * Replace a misspelled word only when there is ONE clear, close match.
   * "Clear" means exactly one dictionary word within one edit. If several fit
   * (e.g. "helo" -> help / hello / hell) or nothing is close (names, unusual
   * words), the word is left alone and reported, because guessing wrong would
   * change the meaning.
   */
  autoFix(text) {
    const tokens = this.analyze(text);
    const changes = [];
    const unresolved = [];
    let out = text;
    for (const t of [...tokens].reverse()) {
      if (t.ok) continue;
      const close = t.suggestions.filter((s) => s.cost <= 1);
      if (close.length === 1) {
        out = out.slice(0, t.start) + close[0].word + out.slice(t.end);
        changes.unshift({ from: t.raw, to: close[0].word });
      } else {
        unresolved.unshift(t.raw);
      }
    }
    return { text: out, changes, unresolved };
  }
}

const QUESTION_WORDS = new Set([
  "what", "where", "when", "who", "whom", "whose", "why", "how", "which",
  "is", "are", "am", "do", "does", "did", "can", "could", "will", "would", "should", "may",
]);

// Fingerspelling has no apostrophe, so restore the common ones (also reads better aloud).
const CONTRACTIONS = {
  im: "I'm", ive: "I've", dont: "don't", cant: "can't", wont: "won't", thats: "that's",
  isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", didnt: "didn't", doesnt: "doesn't",
  hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", couldnt: "couldn't", wouldnt: "wouldn't",
  shouldnt: "shouldn't", youre: "you're", theyre: "they're", hes: "he's", shes: "she's", whats: "what's",
};

/** Capitalise, fix "i" and contractions, and finish with punctuation. */
export function formatSentence(text) {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/\b[a-z]+\b/gi, (w) => CONTRACTIONS[w.toLowerCase()] || w);
  s = s.replace(/\bi\b/g, "I");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.?!]$/.test(s)) {
    const first = s.split(" ")[0].toLowerCase().replace(/[^a-z]/g, "");
    s += QUESTION_WORDS.has(first) ? "?" : ".";
  }
  return s;
}
