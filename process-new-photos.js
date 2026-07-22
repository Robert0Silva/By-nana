const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/img/src');
const OUT = path.join(__dirname, 'assets/img/processed');

// Same enhance recipe as process-images.js, tuned for casual phone photos:
// lift shadows/contrast, warm the color slightly, sharpen for the softness
// that comes from upscaling small source files.
async function enhance(pipeline) {
  return pipeline
    .normalize({ lower: 0.5, upper: 99.5 })
    .modulate({ brightness: 1.08, saturation: 1.12 })
    .linear(1.08, -10) // contrast lift
    .sharpen({ sigma: 0.8 });
}

async function processLook(name, { crop, width = 760 } = {}) {
  const srcPath = path.join(SRC, name);
  const meta = await sharp(srcPath).metadata();
  let pipeline = sharp(srcPath);
  if (crop) {
    const left = Math.round(crop.left * meta.width);
    const top = Math.round(crop.top * meta.height);
    const cw = Math.round((crop.right - crop.left) * meta.width);
    const ch = Math.round((crop.bottom - crop.top) * meta.height);
    pipeline = pipeline.extract({ left, top, width: cw, height: ch });
  }
  pipeline = await enhance(pipeline);
  pipeline = pipeline.resize({ width, withoutEnlargement: false });
  await pipeline.jpeg({ quality: 92, mozjpeg: true }).toFile(path.join(OUT, name));
  console.log('ok:', name);
}

(async () => {
  await processLook('look-jaqueta-animal-print.jpg', {
    crop: { left: 0.02, top: 0.015, right: 0.98, bottom: 0.99 },
  });

  await processLook('look-camisa-calca-xadrez.jpg', {
    crop: { left: 0.03, top: 0.02, right: 0.97, bottom: 1.0 },
  });

  await processLook('look-blazer-shorts-tweed.jpg', {
    crop: { left: 0.06, top: 0.0, right: 0.94, bottom: 1.0 },
  });

  await processLook('look-camisa-saia-xadrez.jpg', {
    crop: { left: 0.0, top: 0.09, right: 0.97, bottom: 1.0 },
  });

  await processLook('look-blazer-marinho-bermuda.jpg', {
    crop: { left: 0.03, top: 0.08, right: 0.96, bottom: 1.0 },
  });

  await processLook('look-alfaiataria-off-white-shorts.jpg', {
    crop: { left: 0.0, top: 0.175, right: 1.0, bottom: 1.0 },
  });

  await processLook('look-cropped-bege-pantalona.jpg', {
    crop: { left: 0.0, top: 0.08, right: 0.96, bottom: 1.0 },
  });

  await processLook('look-regata-renda-bermuda.jpg', {
    crop: { left: 0.02, top: 0.08, right: 0.96, bottom: 1.0 },
  });

  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
