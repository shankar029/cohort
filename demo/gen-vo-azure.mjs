// Azure Neural TTS generator for the Cohort demo.
//   node gen-vo-azure.mjs [envFile] [scenesJson] [outDir]
// Defaults: envFile = ../../wonder-studio/.env, scenes = vo-scenes.json,
//           outDir = video/public/vo
// Writes <outDir>/<id>.wav and vo-durations.json {id: seconds}.
import fs from "node:fs";
import path from "node:path";

const ENV_FILE = process.argv[2] || "C:/code/projects/wonder-studio/.env";
const SCENES = process.argv[3] || "vo-scenes.json";
const OUT_DIR = process.argv[4] || "video/public/vo";

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(ENV_FILE);

const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION;
const VOICE = process.env.COHORT_VOICE || process.env.AZURE_SPEECH_VOICE || "en-US-AndrewMultilingualNeural";
const STYLE = process.env.COHORT_STYLE || ""; // e.g. "narration-professional"
const RATE = process.env.COHORT_RATE || "+2%";
const FORMAT = "riff-48khz-16bit-mono-pcm";
if (!KEY || !REGION) { console.error("Missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION"); process.exit(1); }
const ENDPOINT = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function ssml(text) {
  let inner = esc(text);
  if (RATE) inner = `<prosody rate="${RATE}">${inner}</prosody>`;
  if (STYLE) inner = `<mstts:express-as style="${STYLE}">${inner}</mstts:express-as>`;
  return `<speak version="1.0" xml:lang="en-US" xmlns:mstts="https://www.w3.org/2001/mstts"><voice name="${VOICE}">${inner}</voice></speak>`;
}
async function synth(text, absOut) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": FORMAT,
      "User-Agent": "cohort-demo-tts",
    },
    body: ssml(text),
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status} ${res.statusText} — ${(await res.text().catch(()=>"")).slice(0,300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, buf);
  return buf;
}
function wavSeconds(buf) {
  let byteRate = 0, dataSize = 0, off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 8 + 8);
    if (id === "data") { dataSize = size; break; }
    off += 8 + size + (size % 2);
  }
  return byteRate ? dataSize / byteRate : 0;
}

const scenes = JSON.parse(fs.readFileSync(SCENES, "utf8"));
console.log(`Azure Neural TTS — ${scenes.length} lines, voice ${VOICE} (rate ${RATE}) @ ${REGION}`);
const durations = {};
for (const s of scenes) {
  process.stdout.write(`gen ${s.id} ... `);
  const buf = await synth(s.text, path.resolve(OUT_DIR, `${s.id}.wav`));
  const secs = wavSeconds(buf);
  durations[s.id] = +secs.toFixed(3);
  process.stdout.write(`${secs.toFixed(2)}s\n`);
}
fs.writeFileSync("vo-durations.json", JSON.stringify(durations, null, 2));
const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`\nWrote ${scenes.length} clips to ${OUT_DIR} (${total.toFixed(1)}s total). durations -> vo-durations.json`);
