/* Lays a spoken track over the recording tools/record.mjs produced.
 *
 * Each line is pinned to a cue emitted during capture, so the words land on the
 * frame they describe without anybody nudging a timeline.
 *
 * Speech comes from ElevenLabs when ELEVEN_API_KEY is set, and from macOS `say`
 * otherwise, so the pipeline still runs with no account. A human voice will not
 * hit the same durations as a synthetic one, so any line that overruns its cue
 * window is tempo-fitted with ffmpeg rather than rewritten — atempo preserves
 * pitch, and anything past ~1.15 gets flagged as needing a shorter line.
 *
 *   node tools/narrate.mjs out/            -> out/chartroom-demo.mp4
 */
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || "out";

const EL_KEY = process.env.ELEVEN_API_KEY || "";
const EL_BASE = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1").replace(/\/$/, "");
const EL_VOICE = process.env.ELEVEN_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";  // George — warm, British, narration
const EL_MODEL = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";
const SAY_VOICE = process.env.VOICE || "Daniel";
const SAY_RATE = process.env.RATE || "150";
const MAX_TEMPO = 1.15;      // past this it stops sounding like a person talking

const SCRIPT = [
  ["intro", "This is CHARTROOM. It watches a consultation, and asks one question about the codes."],
  ["standby", "Does what was actually said in the room contain the evidence to defend the bill?"],
  ["roll", "Here is a diabetes review. Speech to text gives the transcript. Corti's coding API predicts what this visit will be billed as. And the desk starts checking whether the note can hold those codes up."],
  ["board", "The office visit code opens red. Moderate complexity needs two of three elements documented. Watch it turn green as the clinician supplies them."],
  ["gap", "Now the big one. The patient has neuropathy. She has diabetes. Both are in the note. Nobody has said they are the same problem."],
  ["closing", "So the desk asks."],
  ["closed", "One sentence. The code flips, and nineteen hundred and seventy dollars moves from at risk to captured."],
  ["ckd", "This is risk adjustment, not a coding trick. Diabetes with a documented complication carries real weight. Diabetes alone does not. Same visit, same care, different revenue."],
  ["uncaptured", "Next, kidney disease with no stage. Then cessation counselling that happened, but was never timed, so nothing gets billed."],
  ["ended", "Visit over. Seven hundred and six dollars still open."],
  ["evidence", "Every green code points back at the exact words defending it. That is Corti's evidence chain, rendered straight into the transcript."],
  ["sayit", "And the gaps stay closeable. Say the missing clause, the requirement resolves, the code turns green."],
  ["outro", "Caught in the room, it is free. Caught by a coder three weeks later, it is a denial."],
];

const dur = (f) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

async function speak(line, file) {
  if (!EL_KEY) {
    execFileSync("say", ["-v", SAY_VOICE, "-r", SAY_RATE, "-o", file, line]);
    return;
  }
  const r = await fetch(`${EL_BASE}/text-to-speech/${EL_VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": EL_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      text: line,
      model_id: EL_MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.05, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** Squeeze a clip into its window without changing its pitch. */
function fit(file, spoken, window) {
  if (window === Infinity || spoken <= window) return { spoken, tempo: 1 };
  const tempo = Math.min((spoken / window) * 1.02, MAX_TEMPO);
  const tmp = file.replace(/(\.\w+)$/, ".fit$1");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-filter:a", `atempo=${tempo.toFixed(4)}`, tmp]);
  renameSync(tmp, file);
  return { spoken: dur(file), tempo };
}

const cues = JSON.parse(readFileSync(join(OUT, "cues.json")));
const ext = EL_KEY ? "mp3" : "aiff";
const clips = [];

for (const [i, [cue, line]] of SCRIPT.entries()) {
  if (!(cue in cues)) throw new Error(`no cue "${cue}" in the recording`);
  const file = join(OUT, `n${i}.${ext}`);
  await speak(line, file);
  const next = SCRIPT[i + 1]?.[0];
  const window = (next ? cues[next] : Infinity) - cues[cue];
  const raw = dur(file);
  const { spoken, tempo } = fit(file, raw, window);
  if (spoken > window + 0.05) {
    console.warn(`⚠ "${cue}" still runs ${spoken.toFixed(1)}s in a ${window.toFixed(1)}s window at max tempo — shorten the line`);
  }
  clips.push({ cue, file, at: cues[cue], raw, spoken, window, tempo });
}

const inputs = clips.flatMap((c) => ["-i", c.file]);
const delays = clips
  .map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[a${i}]`)
  .join(";");
const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0[mixed]`;

execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-i", join(OUT, "silent.mp4"),
  ...inputs,
  "-filter_complex", `${delays};${mix};[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[voice]`,
  "-map", "0:v", "-map", "[voice]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
  "-movflags", "+faststart",
  join(OUT, "chartroom-demo.mp4"),
], { stdio: "inherit" });

console.log(`\nvoice: ${EL_KEY ? `ElevenLabs ${EL_VOICE} (${EL_MODEL})` : `say ${SAY_VOICE}`}\n`);
console.log(clips.map((c) =>
  `${c.cue.padEnd(11)} @${c.at.toFixed(1).padStart(6)}s  ${c.raw.toFixed(1)}s` +
  `${c.tempo > 1 ? ` →${c.spoken.toFixed(1)}s @${c.tempo.toFixed(2)}×` : ""}` +
  ` / ${c.window === Infinity ? "end" : c.window.toFixed(1) + "s"}`
).join("\n"));
console.log(`\n→ ${join(OUT, "chartroom-demo.mp4")}`);
