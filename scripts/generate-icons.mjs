import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const sizes = [16, 32, 48, 128];

const states = {
  idle: '#FFFFFF',
  active: '#F1BC00',
  paused: '#FFFFFF',
};

function createSvg(state, background) {
  const clockSymbol =
    state === 'paused'
      ? `
        <path
          d="M52 47 V81 M76 47 V81"
          fill="none"
          stroke="#000000"
          stroke-width="9"
          stroke-linecap="round"
        />
      `
      : `
        <path
          d="M64 38 V65 L83 76"
          fill="none"
          stroke="#000000"
          stroke-width="9"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      `;

  return `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="128"
      height="128"
      viewBox="0 0 128 128"
    >
      <rect
        x="5"
        y="5"
        width="118"
        height="118"
        rx="25"
        fill="${background}"
      />

      <circle
        cx="64"
        cy="64"
        r="43"
        fill="none"
        stroke="#000000"
        stroke-width="9"
      />

      ${clockSymbol}
    </svg>
  `;
}

await mkdir('public/icons', { recursive: true });

for (const [state, background] of Object.entries(states)) {
  const svg = createSvg(state, background);

  for (const size of sizes) {
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(`public/icons/${state}-${size}.png`);
  }
}

console.log('Icons generated successfully');
