// Runs the exported scikit-learn MLP in the browser (no libraries needed).

/** Same maths as utils.normalize_landmarks in Python. `lms` = 21 {x,y,z} points. */
export function normalizeLandmarks(lms, width, height) {
  const pts = lms.map((p) => [p.x * width, p.y * height, p.z * width]);
  const [wx, wy, wz] = pts[0];
  for (const p of pts) {
    p[0] -= wx;
    p[1] -= wy;
    p[2] -= wz;
  }
  const scale = Math.hypot(pts[9][0], pts[9][1], pts[9][2]);
  const out = new Float32Array(63);
  pts.forEach((p, i) => {
    out[i * 3] = scale > 0 ? p[0] / scale : p[0];
    out[i * 3 + 1] = scale > 0 ? p[1] / scale : p[1];
    out[i * 3 + 2] = scale > 0 ? p[2] / scale : p[2];
  });
  return out;
}

export class Classifier {
  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} not found (HTTP ${res.status})`);
    return new Classifier(await res.json());
  }

  constructor(model) {
    this.classes = model.classes;
    this.means = model.means || {};
    this.layers = model.layers.map((l) => ({
      inSize: l.in,
      outSize: l.out,
      W: Float32Array.from(l.W), // row-major [in][out], as exported by scikit-learn
      b: Float32Array.from(l.b),
    }));
  }

  /** Returns { label, conf, probs } for one 63-value feature vector. */
  predict(x) {
    let a = x;
    this.layers.forEach((L, li) => {
      const out = Float32Array.from(L.b);
      for (let k = 0; k < L.inSize; k++) {
        const ak = a[k];
        if (ak === 0) continue;
        const row = k * L.outSize;
        for (let j = 0; j < L.outSize; j++) out[j] += ak * L.W[row + j];
      }
      if (li < this.layers.length - 1) {
        for (let j = 0; j < out.length; j++) if (out[j] < 0) out[j] = 0; // ReLU
      }
      a = out;
    });
    // softmax
    let max = -Infinity;
    for (const v of a) if (v > max) max = v;
    let sum = 0;
    const probs = a.map((v) => {
      const e = Math.exp(v - max);
      sum += e;
      return e;
    });
    let best = 0;
    for (let i = 0; i < probs.length; i++) {
      probs[i] /= sum;
      if (probs[i] > probs[best]) best = i;
    }
    return { label: this.classes[best], conf: probs[best], probs };
  }
}
