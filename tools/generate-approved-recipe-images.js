#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'app/assets/recipes');
const size = 512;

function crc32(buf){
  let c = -1;
  for(let i = 0; i < buf.length; i++){
    c ^= buf[i];
    for(let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data){
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(rgba){
  const rows = [];
  for(let y = 0; y < size; y++) rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), {level: 9})),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function hash(s){
  let h = 2166136261;
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function blend(img, x, y, color, alpha){
  x = Math.round(x); y = Math.round(y);
  if(x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4, a = Math.max(0, Math.min(1, alpha));
  img[i] = Math.round(img[i] * (1 - a) + color[0] * a);
  img[i + 1] = Math.round(img[i + 1] * (1 - a) + color[1] * a);
  img[i + 2] = Math.round(img[i + 2] * (1 - a) + color[2] * a);
  img[i + 3] = 255;
}

function ellipse(img, cx, cy, rx, ry, color, alpha, rnd, rot = 0){
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for(let y = Math.floor(cy - ry - 18); y <= Math.ceil(cy + ry + 18); y++){
    for(let x = Math.floor(cx - rx - 18); x <= Math.ceil(cx + rx + 18); x++){
      const dx = x - cx, dy = y - cy;
      const px = dx * cos + dy * sin, py = -dx * sin + dy * cos;
      const d = (px * px) / (rx * rx) + (py * py) / (ry * ry);
      if(d <= 1.2){
        const edge = Math.max(0, Math.min(1, (1.2 - d) / 0.3));
        blend(img, x, y, color, alpha * edge * (0.85 + rnd() * 0.25));
      }
    }
  }
}

function rect(img, cx, cy, w, h, color, alpha, rnd, rot = 0){
  const cos = Math.cos(rot), sin = Math.sin(rot), hw = w / 2, hh = h / 2;
  for(let y = Math.floor(cy - h); y <= Math.ceil(cy + h); y++){
    for(let x = Math.floor(cx - w); x <= Math.ceil(cx + w); x++){
      const dx = x - cx, dy = y - cy;
      const px = dx * cos + dy * sin, py = -dx * sin + dy * cos;
      if(Math.abs(px) <= hw && Math.abs(py) <= hh){
        const edge = Math.min(hw - Math.abs(px), hh - Math.abs(py));
        blend(img, x, y, color, alpha * Math.max(0.25, Math.min(1, edge / 14)) * (0.86 + rnd() * 0.2));
      }
    }
  }
}

function line(img, x1, y1, x2, y2, color, alpha, width, rnd){
  const steps = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  for(let i = 0; i <= steps; i++){
    const t = i / steps;
    ellipse(img, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width, width, color, alpha, rnd);
  }
}

function triangle(img, ax, ay, bx, by, cx, cy, color, alpha, rnd){
  const minX = Math.floor(Math.min(ax, bx, cx) - 12), maxX = Math.ceil(Math.max(ax, bx, cx) + 12);
  const minY = Math.floor(Math.min(ay, by, cy) - 12), maxY = Math.ceil(Math.max(ay, by, cy) + 12);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for(let y = minY; y <= maxY; y++){
    for(let x = minX; x <= maxX; x++){
      const w1 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
      const w2 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
      const w3 = 1 - w1 - w2;
      if(w1 >= -0.04 && w2 >= -0.04 && w3 >= -0.04) blend(img, x, y, color, alpha * (0.78 + rnd() * 0.24));
    }
  }
}

function base(seed){
  const rnd = rng(hash(seed));
  const img = Buffer.alloc(size * size * 4);
  for(let y = 0; y < size; y++){
    for(let x = 0; x < size; x++){
      const i = (y * size + x) * 4, g = Math.floor((rnd() - 0.5) * 14);
      img[i] = 244 + g; img[i + 1] = 236 + g; img[i + 2] = 215 + g; img[i + 3] = 255;
    }
  }
  ellipse(img, 256, 334, 150, 38, [178,160,126], 0.12, rnd);
  ellipse(img, 256, 318, 142, 46, [237,226,198], 0.35, rnd);
  return {img, rnd};
}

const art = {
  'polpette-tacchino-yogurt-menta': ({img, rnd}) => {
    [[210,245],[270,232],[320,264],[238,292],[294,306]].forEach(([x,y]) => ellipse(img, x, y, 34, 28, [146,93,67], 0.55, rnd));
    ellipse(img, 262, 273, 104, 56, [232,229,203], 0.3, rnd);
    [[205,209],[252,198],[305,210],[335,236],[185,270]].forEach(([x,y]) => ellipse(img, x, y, 17, 8, [89,137,91], 0.45, rnd, rnd() * 3));
  },
  'feta-filo-miele-noodles-verdure': ({img, rnd}) => {
    triangle(img, 210, 182, 332, 210, 250, 300, [222,179,94], 0.46, rnd);
    triangle(img, 234, 168, 350, 198, 276, 282, [238,211,141], 0.38, rnd);
    for(let i = 0; i < 8; i++) line(img, 176 + i * 18, 322 + Math.sin(i) * 5, 340 + i * 3, 312 + Math.cos(i) * 8, [205,163,94], 0.18, 3, rnd);
    [[185,260],[355,268],[168,300],[346,328]].forEach(([x,y]) => ellipse(img, x, y, 30, 13, [98,142,87], 0.38, rnd, rnd()));
  },
  'pomodori-al-riso': ({img, rnd}) => {
    [[218,250],[296,244],[258,306]].forEach(([x,y]) => {
      ellipse(img, x, y, 46, 40, [182,71,58], 0.56, rnd);
      ellipse(img, x, y - 4, 28, 18, [236,211,151], 0.46, rnd);
      ellipse(img, x - 8, y - 26, 13, 7, [88,129,78], 0.5, rnd, -0.4);
    });
  },
  'ricotta-pere-noci-toast': ({img, rnd}) => {
    rect(img, 258, 273, 170, 116, [188,133,70], 0.42, rnd, -0.08);
    rect(img, 258, 270, 145, 88, [229,197,136], 0.38, rnd, -0.08);
    ellipse(img, 245, 260, 78, 38, [239,235,211], 0.56, rnd, -0.08);
    ellipse(img, 295, 228, 26, 44, [181,153,76], 0.42, rnd, 0.22);
    [[212,303],[280,310],[323,278]].forEach(([x,y]) => ellipse(img, x, y, 16, 11, [111,76,48], 0.44, rnd, rnd()));
  },
  'uova-avocado-toast': ({img, rnd}) => {
    rect(img, 250, 286, 176, 112, [182,124,66], 0.42, rnd, 0.08);
    rect(img, 250, 282, 148, 82, [228,190,121], 0.35, rnd, 0.08);
    ellipse(img, 225, 260, 44, 66, [86,130,76], 0.5, rnd, -0.35);
    ellipse(img, 225, 260, 26, 42, [171,177,83], 0.46, rnd, -0.35);
    ellipse(img, 291, 270, 42, 32, [246,241,218], 0.7, rnd);
    ellipse(img, 291, 270, 16, 15, [223,154,59], 0.62, rnd);
  },
  'carrots-over-hummus': ({img, rnd}) => {
    ellipse(img, 260, 292, 92, 56, [217,194,131], 0.48, rnd);
    ellipse(img, 260, 292, 48, 28, [236,216,157], 0.32, rnd);
    [[210,225,-0.7],[260,213,-0.2],[312,230,0.42]].forEach(([x,y,rot]) => {
      rect(img, x, y, 108, 24, [218,118,57], 0.52, rnd, rot);
      ellipse(img, x - Math.cos(rot) * 62, y - Math.sin(rot) * 62, 19, 8, [92,137,83], 0.45, rnd, rot);
    });
  },
  'spring-rolls': ({img, rnd}) => {
    [[220,238,-0.18],[278,268,0.2],[238,310,-0.05]].forEach(([x,y,rot]) => {
      rect(img, x, y, 136, 38, [219,180,104], 0.48, rnd, rot);
      line(img, x - 58 * Math.cos(rot), y - 58 * Math.sin(rot), x + 58 * Math.cos(rot), y + 58 * Math.sin(rot), [178,119,68], 0.12, 1.6, rnd);
    });
    ellipse(img, 337, 250, 36, 20, [170,63,52], 0.42, rnd);
    ellipse(img, 344, 248, 18, 10, [214,107,73], 0.34, rnd);
  }
};

for(const [key, painter] of Object.entries(art)){
  const canvas = base(key);
  painter(canvas);
  fs.writeFileSync(path.join(outDir, key + '.png'), png(canvas.img));
}
console.log(`Generated ${Object.keys(art).length} approved recipe images`);
