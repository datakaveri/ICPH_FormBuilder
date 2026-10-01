const assert = require("node:assert/strict");
const { BrowserMultiFormatOneDReader, BrowserQRCodeReader } = require("@zxing/browser");
const { BarcodeFormat, QRCodeWriter } = require("@zxing/library");
const code128Patterns = require("@zxing/library/cjs/core/oned/Code128Reader").default.CODE_PATTERNS;

function frameFromPixels(width, height, isBlack) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const shade = isBlack(x, y) ? 0 : 255;
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function code128Frame(value) {
  const codes = [104, ...[...value].map((letter) => letter.charCodeAt(0) - 32)];
  assert(codes.slice(1).every((code) => code >= 0 && code <= 95));
  let checksum = 104;
  for (let index = 1; index < codes.length; index++) checksum += index * codes[index];
  codes.push(checksum % 103, 106);

  const bars = [];
  for (const code of codes) {
    let dark = true;
    for (const modules of code128Patterns[code]) {
      for (let pixel = 0; pixel < modules * 3; pixel++) bars.push(dark);
      dark = !dark;
    }
  }
  return frameFromPixels(bars.length + 60, 150, (x, y) => y >= 20 && y < 130 && bars[x - 30]);
}

function qrFrame(value) {
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 320, 320, new Map());
  return frameFromPixels(matrix.getWidth(), matrix.getHeight(), (x, y) => matrix.get(x, y));
}

global.HTMLVideoElement = class {
  constructor(frame) {
    this.videoWidth = frame.width;
    this.videoHeight = frame.height;
    this.pixels = frame.pixels;
  }
};
global.document = {
  createElement(tag) {
    assert.equal(tag, "canvas");
    const canvas = { style: {}, width: 0, height: 0 };
    canvas.getContext = () => ({
      drawImage(video) { canvas.pixels = video.pixels; },
      getImageData() { return { data: canvas.pixels }; }
    });
    return canvas;
  }
};

const value = "P-12345";
assert.equal(new BrowserMultiFormatOneDReader().decode(new HTMLVideoElement(code128Frame(value))).getText(), value);
assert.equal(new BrowserQRCodeReader().decode(new HTMLVideoElement(qrFrame(value))).getText(), value);
console.log("Code 128 and QR camera frames decoded successfully.");
