/* global require, __dirname, console, process */
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const directory = path.join(__dirname, '..', 'assets', 'img', 'processed');
const widths = [320, 640, 1000];

async function main() {
  const files = (await fs.readdir(directory)).filter((file) => /\.(?:jpe?g|png)$/i.test(file) && !/-\d+\.webp$/i.test(file));
  for (const file of files) {
    const input = path.join(directory, file);
    const stem = path.basename(file, path.extname(file));
    for (const width of widths) {
      await sharp(input)
        .resize({ width })
        .webp({ quality: 82, effort: 4 })
        .toFile(path.join(directory, `${stem}-${width}.webp`));
    }
  }
  console.log(`Variantes responsivas geradas para ${files.length} imagens.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
