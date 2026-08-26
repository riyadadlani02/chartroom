/* Lays a spoken track over the recording tools/record.mjs produced.
 *
 * Each line is pinned to a cue emitted during capture, so the words land on
 * the frame they describe without anybody nudging a timeline. macOS `say` does
 * the speech; ffmpeg delays each clip to its cue and mixes.
 *
 *   node tools/narrate.mjs out/            -> out/chartroom-demo.mp4
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || "out";
const VOICE = process.env.VOICE || "Daniel";
const RATE = process.env.RATE || "150";

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

const cues = JSON.parse(readFileSync(join(OUT, "cues.json")));
const dur = (f) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

const clips = [];
SCRIPT.forEach(([cue, line], i) => {
  if (!(cue in cues)) throw new Error(`no cue "${cue}" in the recording`);
  const file = join(OUT, `n${i}.aiff`);
  execFileSync("say", ["-v", VOICE, "-r", RATE, "-o", file, line]);
  const next = SCRIPT[i + 1]?.[0];
  const window = (next ? cues[next] : Infinity) - cues[cue];
  const spoken = dur(file);
  if (spoken > window) {
    console.warn(`⚠ "${cue}" runs ${spoken.toFixed(1)}s into a ${window.toFixed(1)}s window — trim the line`);
  }
  clips.push({ file, at: cues[cue], spoken, window });
});

const inputs = clips.flatMap((c) => ["-i", c.file]);
const delays = clips
  .map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[a${i}]`)
  .join(";");
const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0[mixed]`;

execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-i", join(OUT, "silent.mp4"),
  ...inputs,
  "-filter_complex", `${delays};${mix};[mixed]volume=1.6,alimiter=limit=0.95[voice]`,
  "-map", "0:v", "-map", "[voice]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
  "-movflags", "+faststart",
  join(OUT, "chartroom-demo.mp4"),
], { stdio: "inherit" });

console.log("\n" + clips.map((c, i) =>
  `${String(SCRIPT[i][0]).padEnd(11)} @${c.at.toFixed(1).padStart(6)}s  ${c.spoken.toFixed(1)}s / ${c.window === Infinity ? "end" : c.window.toFixed(1) + "s"}`
).join("\n"));
console.log(`\n→ ${join(OUT, "chartroom-demo.mp4")}`);
