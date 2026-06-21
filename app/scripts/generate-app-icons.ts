import { existsSync, mkdirSync } from "node:fs";

const ICONSET_DIR = "icon.iconset";
const SOURCE_ICON = "assets/app-icon.png";

const ICONSET_FILES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
] as const;

mkdirSync(ICONSET_DIR, { recursive: true });

if (!existsSync(SOURCE_ICON)) {
  throw new Error(`Missing source icon: ${SOURCE_ICON}`);
}

for (const [fileName, size] of ICONSET_FILES) {
  resizePng(size, `${ICONSET_DIR}/${fileName}`);
}

console.log(`Generated ${ICONSET_FILES.length} macOS iconset PNGs from ${SOURCE_ICON}`);

function resizePng(size: number, outputPath: string) {
  const result = Bun.spawnSync([
    "sips",
    "-s",
    "format",
    "png",
    "-z",
    String(size),
    String(size),
    SOURCE_ICON,
    "--out",
    outputPath,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `sips failed while generating ${outputPath}\n${result.stderr.toString()}`,
    );
  }
}
