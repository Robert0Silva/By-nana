const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/img/src');
const OUT = path.join(__dirname, 'assets/img/processed');

// Soft pearl/cream backdrop matching the By NaNa logo card, used behind
// isolated product shots so they read as one coherent catalog.
const CARD_BG = { r: 238, g: 235, b: 230, alpha: 1 };

async function enhance(input) {
  return input
    .normalize({ lower: 1, upper: 99 })
    .modulate({ brightness: 1.06, saturation: 1.1 })
    .linear(1.04, -6) // gentle contrast lift
    .sharpen({ sigma: 0.6 });
}

async function processLook(name, { crop } = {}) {
  let img = sharp(path.join(SRC, name));
  const meta = await img.metadata();
  let pipeline = sharp(path.join(SRC, name));
  if (crop) {
    const left = Math.round(crop.left * meta.width);
    const top = Math.round(crop.top * meta.height);
    const width = Math.round((crop.right - crop.left) * meta.width);
    const height = Math.round((crop.bottom - crop.top) * meta.height);
    pipeline = pipeline.extract({ left, top, width, height });
  }
  pipeline = await enhance(pipeline);
  const outName = name.replace('.png', '.jpg');
  await pipeline.jpeg({ quality: 90, mozjpeg: true }).toFile(path.join(OUT, outName));
  console.log('look ok:', outName);
}

async function processProduct(name, { crop, ratio = 4 / 5 } = {}) {
  const srcPath = path.join(SRC, name);
  const meta = await sharp(srcPath).metadata();
  let pipeline = sharp(srcPath);
  if (crop) {
    const left = Math.round(crop.left * meta.width);
    const top = Math.round(crop.top * meta.height);
    const width = Math.round((crop.right - crop.left) * meta.width);
    const height = Math.round((crop.bottom - crop.top) * meta.height);
    pipeline = pipeline.extract({ left, top, width, height });
  }
  pipeline = await enhance(pipeline);
  const buf = await pipeline.png().toBuffer();

  const canvasW = 1200;
  const canvasH = Math.round(canvasW / ratio);
  const outName = name.replace('.png', '.jpg');
  await sharp(buf)
    .resize({ width: canvasW, height: canvasH, fit: 'cover', position: 'centre' })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(path.join(OUT, outName));
  console.log('product ok:', outName);
}

async function processLogo() {
  const srcPath = path.join(SRC, 'logo.png');
  const meta = await sharp(srcPath).metadata();
  // tight crop around the wordmark, trimming the empty gradient margins
  const crop = { left: 0.05, top: 0.14, right: 0.95, bottom: 0.965 };
  const left = Math.round(crop.left * meta.width);
  const top = Math.round(crop.top * meta.height);
  const width = Math.round((crop.right - crop.left) * meta.width);
  const height = Math.round((crop.bottom - crop.top) * meta.height);
  await sharp(srcPath)
    .extract({ left, top, width, height })
    .png()
    .toFile(path.join(OUT, 'logo.png'));
  console.log('logo ok');
}

(async () => {
  await processLogo();

  await processLook('look-pijama-xadrez.png');
  await processLook('look-tricot-conjunto.png');
  await processLook('look-alfaiataria-off-white.png');
  await processLook('look-masc-tshirt-jeans.png');
  await processLook('look-masc-camisa-preta.png');
  await processLook('look-masc-regata.png', { crop: { left: 0.24, top: 0, right: 1, bottom: 1 } });

  await processProduct('produto-scarpin-preto.png', {
    crop: { left: 0.02, top: 0.3, right: 1, bottom: 0.75 },
    ratio: (1 - 0.02) / (0.75 - 0.3),
  });
  await processLook('produto-tenis-constance.png', {
    crop: { left: 0, top: 0.09, right: 1, bottom: 1 },
  });

  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
