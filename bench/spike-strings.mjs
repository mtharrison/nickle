// Spike 2.2: ASCII string decode strategies across lengths 1-256.

const LENGTHS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const COUNT = 4096;
const td = new TextDecoder();

function loop(u8, a, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(u8[a + i]);
  return s;
}
function apply(u8, a, n) {
  return String.fromCharCode.apply(null, u8.subarray(a, a + n));
}
function latin1(buf, a, n) {
  return buf.latin1Slice(a, a + n);
}
function textDecoder(u8, a, n) {
  return td.decode(u8.subarray(a, a + n));
}

const strategies = {
  loop: (u8, buf, a, n) => loop(u8, a, n),
  apply: (u8, buf, a, n) => apply(u8, a, n),
  latin1: (u8, buf, a, n) => latin1(buf, a, n),
  textDecoder: (u8, buf, a, n) => textDecoder(u8, a, n),
};

const rows = [];
for (const len of LENGTHS) {
  const ab = new ArrayBuffer(len * COUNT);
  const u8 = new Uint8Array(ab);
  for (let i = 0; i < u8.length; i++) u8[i] = 32 + ((i * 7919) % 95);
  const buf = Buffer.from(ab);
  const row = { len };
  for (const [name, fn] of Object.entries(strategies)) {
    const iters = Math.max(200_000, Math.floor(20_000_000 / len));
    let sink = 0;
    for (let i = 0; i < 100_000; i++) sink += fn(u8, buf, (i % COUNT) * len, len).length;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn(u8, buf, (i % COUNT) * len, len).length;
    row[name] = Number(process.hrtime.bigint() - t0) / iters;
    if (sink === 0) throw new Error("dead code");
  }
  rows.push(row);
}
console.log("len  " + Object.keys(strategies).map((s) => s.padStart(12)).join(""));
for (const r of rows) {
  console.log(String(r.len).padEnd(5) + Object.keys(strategies)
    .map((s) => r[s].toFixed(1).padStart(12)).join(""));
}
console.log(JSON.stringify(rows));
