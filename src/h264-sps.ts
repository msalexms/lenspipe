/**
 * Low-delay H.264 output.
 *
 * When an H.264 SPS does not carry VUI `bitstream_restriction`, a conforming decoder must assume frames
 * may be reordered and holds up to the whole DPB before output: 13 frames (~430 ms at 30 fps) for 1080p at
 * level 5.0, which is what Safari's encoder emits in "quality" mode. The iPhone stream has no reordering
 * (no B-frames), so we rewrite the SPS to declare `max_num_reorder_frames = 0` and every frame is output
 * as soon as it is decoded. Everything else in the SPS is copied bit for bit.
 */

class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length * 8 - this.bit;
  }
  u(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.bit >= this.bytes.length * 8) throw new Error('SPS truncated');
      value = value * 2 + ((this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new Error('SPS exp-Golomb overflow');
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number {
    const value = this.ue();
    return value % 2 ? (value + 1) / 2 : -(value / 2);
  }
}

class BitWriter {
  private readonly bits: number[] = [];
  u(count: number, value: number): void {
    for (let i = count - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
  }
  ue(value: number): void {
    const coded = value + 1;
    const length = Math.floor(Math.log2(coded));
    this.u(length, 0);
    this.u(length + 1, coded);
  }
  se(value: number): void {
    this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }
  /** rbsp_trailing_bits + byte alignment. */
  finish(): Uint8Array {
    this.bits.push(1);
    while (this.bits.length % 8) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) out[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return out;
  }
}

/** Reads from the original SPS and writes the same values to the new one. */
class Copier {
  constructor(readonly r: BitReader, readonly w: BitWriter) {}
  u(count: number): number { const v = this.r.u(count); this.w.u(count, v); return v; }
  ue(): number { const v = this.r.ue(); this.w.ue(v); return v; }
  se(): number { const v = this.r.se(); this.w.se(v); return v; }
}

function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && out[out.length - 1] === 0 && out[out.length - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function escape(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function copyHrd(c: Copier): void {
  const count = c.ue() + 1;
  c.u(4);
  c.u(4);
  for (let i = 0; i < count; i++) {
    c.ue();
    c.ue();
    c.u(1);
  }
  c.u(20);
}

export interface SpsInfo {
  profile: number;
  level: number;
  widthMbs: number;
  heightMapUnits: number;
  maxRefFrames: number;
  vuiPresent: boolean;
  fullRange: number | null;
  /** max_num_reorder_frames / max_dec_frame_buffering from the input, when it had bitstream_restriction. */
  reorder: number | null;
  dpb: number | null;
}

/** Returns the SPS NAL unit (with header byte) rewritten for zero reordering, or null if it can't parse it. */
export function patchSpsForLowDelay(nal: Uint8Array): Uint8Array | null {
  return transcode(nal)?.out ?? null;
}

/** Parses an SPS NAL unit (for diagnostics and tests). */
export function inspectSps(nal: Uint8Array): SpsInfo | null {
  return transcode(nal)?.info ?? null;
}

function transcode(nal: Uint8Array): { out: Uint8Array; info: SpsInfo } | null {
  try {
    if ((nal[0] & 0x1f) !== 7) return null;
    const r = new BitReader(unescape(nal.subarray(1)));
    const w = new BitWriter();
    const c = new Copier(r, w);
    const profile = c.u(8);
    c.u(8);
    const level = c.u(8);
    c.ue();
    if (HIGH_PROFILES.has(profile)) {
      const chroma = c.ue();
      if (chroma === 3) c.u(1);
      c.ue();
      c.ue();
      c.u(1);
      if (c.u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (!c.u(1)) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + c.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    c.ue();
    const pocType = c.ue();
    if (pocType === 0) c.ue();
    else if (pocType === 1) {
      c.u(1);
      c.se();
      c.se();
      const cycle = c.ue();
      for (let i = 0; i < cycle; i++) c.se();
    }
    const maxRefFrames = c.ue();
    c.u(1);
    const widthMbs = c.ue() + 1;
    const heightMapUnits = c.ue() + 1;
    let fullRange: number | null = null;
    let reorder: number | null = null;
    let dpb: number | null = null;
    if (!c.u(1)) c.u(1);
    c.u(1);
    if (c.u(1)) {
      c.ue();
      c.ue();
      c.ue();
      c.ue();
    }
    // Defaults from the spec (E.2.1) for the fields we must write if bitstream_restriction was absent.
    let restriction = { mvOverBoundaries: 1, maxBytesPerPicDenom: 2, maxBitsPerMbDenom: 1, log2MvH: 16, log2MvV: 16 };
    const vuiPresent = r.u(1);
    w.u(1, 1);
    if (vuiPresent) {
      if (c.u(1)) {
        if (c.u(8) === 255) c.u(32);
      }
      if (c.u(1)) c.u(1);
      if (c.u(1)) {
        c.u(3);
        fullRange = c.u(1);
        if (c.u(1)) c.u(24);
      }
      if (c.u(1)) {
        c.ue();
        c.ue();
      }
      if (c.u(1)) c.u(65);
      const nalHrd = c.u(1);
      if (nalHrd) copyHrd(c);
      const vclHrd = c.u(1);
      if (vclHrd) copyHrd(c);
      if (nalHrd || vclHrd) c.u(1);
      c.u(1);
      if (r.u(1)) {
        restriction = { mvOverBoundaries: r.u(1), maxBytesPerPicDenom: r.ue(), maxBitsPerMbDenom: r.ue(), log2MvH: r.ue(), log2MvV: r.ue() };
        reorder = r.ue();
        dpb = r.ue();
      }
    } else {
      // Minimal VUI: aspect, overscan, video signal, chroma loc, timing, NAL HRD, VCL HRD and
      // pic_struct flags all 0 (8 bits; low_delay_hrd_flag only exists with HRD), then bitstream_restriction.
      for (let i = 0; i < 8; i++) w.u(1, 0);
    }
    w.u(1, 1);
    w.u(1, restriction.mvOverBoundaries);
    w.ue(restriction.maxBytesPerPicDenom);
    w.ue(restriction.maxBitsPerMbDenom);
    w.ue(restriction.log2MvH);
    w.ue(restriction.log2MvV);
    w.ue(0);
    w.ue(Math.max(1, maxRefFrames));
    const body = escape(w.finish());
    const out = new Uint8Array(body.length + 1);
    out[0] = nal[0];
    out.set(body, 1);
    return {
      out,
      info: { profile, level, widthMbs, heightMapUnits, maxRefFrames, vuiPresent: Boolean(vuiPresent), fullRange, reorder, dpb },
    };
  } catch {
    return null;
  }
}

/** Rewrites every SPS inside an avcC record. Returns null when nothing could be patched. */
export function patchAvcCForLowDelay(avcC: Uint8Array): Uint8Array | null {
  try {
    if (avcC.length < 7 || avcC[0] !== 1) return null;
    const parts: Uint8Array[] = [avcC.subarray(0, 6)];
    const spsCount = avcC[5] & 0x1f;
    let offset = 6;
    let patched = 0;
    for (let i = 0; i < spsCount; i++) {
      const length = (avcC[offset] << 8) | avcC[offset + 1];
      const sps = avcC.subarray(offset + 2, offset + 2 + length);
      if (sps.length !== length) return null;
      const next = patchSpsForLowDelay(sps);
      const chosen = next ?? sps;
      if (next) patched++;
      parts.push(Uint8Array.of(chosen.length >> 8, chosen.length & 0xff), chosen);
      offset += 2 + length;
    }
    parts.push(avcC.subarray(offset));
    if (!patched) return null;
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  } catch {
    return null;
  }
}
