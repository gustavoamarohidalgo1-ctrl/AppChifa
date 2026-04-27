import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const assetsDir = new URL("../assets/", import.meta.url);

function crc32(buffer) {
  let crc = -1;

  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);

  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));

  return Buffer.concat([length, name, data, crc]);
}

function png(width, height, draw) {
  const rows = [];

  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;

    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = draw(x, y, width, height);
      const offset = 1 + x * 4;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = a;
    }

    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function mix(a, b, amount) {
  return Math.round(a + (b - a) * amount);
}

function iconPixel(x, y, width, height) {
  const nx = x / width;
  const ny = y / height;
  const shade = Math.min(1, Math.max(0, ny * 0.38 + nx * 0.1));
  let color = [mix(127, 161, shade), mix(29, 29, shade), mix(29, 33, shade), 255];

  const cx = width * 0.5;
  const bowlY = height * 0.62;
  const bowlW = width * 0.58;
  const bowlH = height * 0.24;
  const dx = (x - cx) / bowlW;
  const dy = (y - bowlY) / bowlH;
  const inBowl = dx * dx + dy * dy < 0.26 && y > height * 0.52;

  const rim = Math.abs(y - height * 0.54) < height * 0.018 && Math.abs(x - cx) < bowlW * 0.58;
  const steam =
    (Math.abs(x - width * 0.42 - Math.sin(ny * 22) * width * 0.025) < width * 0.018 ||
      Math.abs(x - width * 0.51 - Math.sin(ny * 20) * width * 0.025) < width * 0.018 ||
      Math.abs(x - width * 0.6 - Math.sin(ny * 18) * width * 0.025) < width * 0.018) &&
    y > height * 0.18 &&
    y < height * 0.48;

  const chopstickOne = Math.abs(y - (height * 0.31 + (x - width * 0.18) * 0.35)) < width * 0.012;
  const chopstickTwo = Math.abs(y - (height * 0.25 + (x - width * 0.2) * 0.35)) < width * 0.012;
  const inStickRange = x > width * 0.16 && x < width * 0.82 && y > height * 0.2 && y < height * 0.55;

  if (steam) color = [255, 237, 213, 255];
  if ((chopstickOne || chopstickTwo) && inStickRange) color = [250, 204, 21, 255];
  if (rim) color = [255, 247, 237, 255];
  if (inBowl) color = [255, 237, 213, 255];

  return color;
}

function splashPixel(x, y, width, height) {
  const nx = x / width;
  const ny = y / height;
  const glow = Math.max(0, 1 - Math.hypot(nx - 0.5, ny - 0.46) * 2.6);
  const base = [255, 247, 237, 255];
  const warm = [254, 215, 170, 255];

  return [
    mix(base[0], warm[0], glow * 0.65),
    mix(base[1], warm[1], glow * 0.65),
    mix(base[2], warm[2], glow * 0.65),
    255
  ];
}

mkdirSync(assetsDir, { recursive: true });
writeFileSync(new URL("icon.png", assetsDir), png(1024, 1024, iconPixel));
writeFileSync(new URL("adaptive-icon.png", assetsDir), png(1024, 1024, iconPixel));
writeFileSync(new URL("splash.png", assetsDir), png(1242, 2436, splashPixel));
writeFileSync(new URL("favicon.png", assetsDir), png(64, 64, iconPixel));
