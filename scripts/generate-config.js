const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env.local');
const outPath = path.resolve(__dirname, '..', 'spachbob-config.js');

function parseEnv(content) {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .reduce((acc, line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return acc;
      const key = line.substring(0, eq).trim();
      const val = line.substring(eq + 1).trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      acc[key] = val;
      return acc;
    }, {});
}

if (!fs.existsSync(envPath)) {
  console.error('.env.local not found at', envPath);
  process.exit(1);
}

const env = parseEnv(fs.readFileSync(envPath, 'utf8'));

const candidates = ['OPENCODE_API_KEY'];

let openCodeApiKey = null;
for (const k of candidates) {
  if (env[k]) {
    openCodeApiKey = env[k];
    break;
  }
}

if (!openCodeApiKey) {
  console.error('No OpenCode API key found in .env.local. Tried keys:', candidates.join(', '));
  process.exit(1);
}

const outContent = `window.__SPACHBOB_OPENCODE_API_KEY__ = ${JSON.stringify(openCodeApiKey)};\n`;
fs.writeFileSync(outPath, outContent, 'utf8');
console.log('Wrote', outPath);
