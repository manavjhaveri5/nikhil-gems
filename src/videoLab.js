import {
  ALL_FORMATS, BlobSource, Input, Output, Mp4OutputFormat, BufferTarget,
  CanvasSink, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
  VideoSample, VideoSampleSource, Quality, getFirstEncodableVideoCodec,
} from "mediabunny";
import { createPipeline, cropGeometry, renderPipeline, setPipelineSource } from "./glPipeline.js";

/* The engine behind the listing video editor.

   Two ways out of here, and which one runs is the whole design:

   • Copy. If all you did was choose where the clip starts and stops (and, when
     merging, the pieces were shot on the same camera), the encoded frames are
     lifted out of the source and dropped into a new container untouched. Not
     "high quality" — the same bytes. A clip can be trimmed and re-trimmed all
     week without ever losing a generation.

   • Render. The moment a colour slider moves or the frame is cropped, the
     pixels have to change, so every frame is decoded, run through the same
     WebGL pass the photo editor uses, and re-encoded. Quality is set by a
     quantizer rather than a bitrate, so a still, well-lit shot of a stone on a
     white sweep costs what it costs instead of being padded to a target.

   Audio is never re-encoded either way: nothing here touches it, so its packets
   are copied across and only the timestamps move. */

/* Etsy's listing video is capped at 15 seconds and wants at least 5, and it is
   the tightest of the marketplaces this app publishes to — so it sets the
   limits the editor draws. Etsy also plays listing videos muted. */
export const ETSY_MAX_SECONDS = 15;
export const ETSY_MIN_SECONDS = 5;
export const ETSY_MAX_BYTES = 100 * 1024 * 1024;

/* Marketplaces re-encode anything they are given, and they do it from whatever
   resolution arrives — so there's nothing to gain from handing over 4K. 1080 on
   the long edge is what every one of them displays at, and it keeps the render
   inside a hardware encoder's comfortable range. */
export const MAX_RENDER_EDGE = 1920;

const codecKey = cfg => cfg
  ? [cfg.codec, cfg.codedWidth, cfg.codedHeight, cfg.description ? [...new Uint8Array(cfg.description)].join(",") : ""].join("|")
  : "";

/* Opens a clip and reads everything the editor needs to draw its own UI before
   a single frame is decoded. The blob is held rather than the URL: the file is
   read many times over (scrub, filmstrip, export) and re-fetching it each time
   would put the whole clip back on the wire. */
export async function openClip(src, label = "") {
  const blob = typeof src === "string"
    ? await (async () => {
        const res = await fetch(src, { mode: "cors" });
        if (!res.ok) throw new Error(`Couldn't load the video (${res.status})`);
        return res.blob();
      })()
    : src;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("That file has no video track.");
  if (!(await video.canDecode())) throw new Error("This browser can't decode that video's format.");
  const audio = await input.getPrimaryAudioTrack();
  const [duration, width, height, codec, decoderConfig, rotation] = await Promise.all([
    input.computeDuration(), video.getDisplayWidth(), video.getDisplayHeight(),
    video.getCodec(), video.getDecoderConfig(), video.getRotation(),
  ]);
  let fps = 30;
  try { fps = (await video.computeFrameRateMetrics()).bestGuessFrameRate || 30; } catch {}
  return {
    id: Math.random().toString(36).slice(2, 9),
    label: label || (typeof src === "string" ? src.split("/").pop().split("?")[0] : src.name) || "clip",
    url: typeof src === "string" ? src : "",
    blob, input, video, audio, duration, width, height, codec, rotation, fps,
    bytes: blob.size,
    audioKey: audio ? codecKey(await audio.getDecoderConfig()) : "",
    videoKey: codecKey(decoderConfig),
    // Where the clip is cut. Whole clip to start with.
    in: 0, out: duration,
  };
}

export function closeClip(clip) { try { clip?.input?.dispose(); } catch {} }

export const clipLength = c => Math.max(0, c.out - c.in);
export const totalLength = clips => clips.reduce((n, c) => n + clipLength(c), 0);

/* A sink that hands back ready-to-draw canvases rather than raw frames: it has
   already applied the file's own rotation and pixel aspect ratio, which is what
   keeps a portrait clip off an iPhone from arriving on its side. */
export function frameSink(clip, opts = {}) {
  return new CanvasSink(clip.video, { poolSize: 2, ...opts });
}

/* The strip of stills under the timeline. Deliberately short and wide: it is
   there to find the moment the stone turns, not to be looked at. */
export async function buildFilmstrip(clip, count, height = 44) {
  const sink = frameSink(clip, { height, poolSize: 0 });
  const step = clip.duration / count;
  const times = Array.from({ length: count }, (_, i) => Math.min(clip.duration - 0.01, i * step + step / 2));
  const out = [];
  for await (const wrapped of sink.canvasesAtTimestamps(times)) out.push(wrapped?.canvas || null);
  return out;
}

/* Whether the encoded frames can simply be moved across. Colour and crop both
   rewrite pixels, and merging demands every piece decode the same way — one
   iPhone clip and one from a DSLR cannot share a track without re-encoding. */
export function canCopy({ clips, recipeTouched }) {
  if (recipeTouched) return { ok: false, why: "the colour or the frame was changed" };
  if (clips.length > 1 && clips.some(c => c.videoKey !== clips[0].videoKey))
    return { ok: false, why: "the clips came off different cameras, so they don't share an encoding" };
  if (clips.some(c => c.codec !== "avc" && c.codec !== "hevc" && c.codec !== "av1" && c.codec !== "vp9"))
    return { ok: false, why: "that codec can't go into an MP4 as-is" };
  return { ok: true, why: "" };
}

/* Where a copy actually starts. An encoded frame in the middle of the clip is
   described as a difference from the ones before it, so the earliest point that
   can be copied without decoding anything is the last key frame at or before
   the mark. The editor shows the seller this number rather than silently moving
   their cut. */
export async function keyframeBefore(clip, t) {
  const sink = new EncodedPacketSink(clip.video);
  const key = await sink.getKeyPacket(t, { verifyKeyPackets: true });
  return key ? key.timestamp : 0;
}

/* Audio rides along untouched in both paths: copy its packets from the one
   covering the in-point and slide the timestamps. Every AAC packet is a key
   packet, so there is no snapping to do here.

   The packet the cut lands inside starts fractionally before it, which would
   put the first sound at a negative time — and an MP4 has nowhere to put that.
   So that one packet is left behind. It costs about twenty milliseconds at the
   head, which is under a frame and well under anything an ear finds. */
async function pumpAudio(clip, source, startTs, offset, endTs) {
  const sink = new EncodedPacketSink(clip.audio);
  const meta = { decoderConfig: await clip.audio.getDecoderConfig() };
  const first = await sink.getPacket(startTs);
  for await (const p of sink.packets(first ?? undefined)) {
    if (p.timestamp >= endTs) break;
    const timestamp = p.timestamp - startTs + offset;
    if (timestamp < 0) continue;
    await source.add(p.clone({ timestamp }), meta);
  }
}

function newOutput() {
  return new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
}

async function finish(output) {
  await output.finalize();
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

/* ── The copy path ────────────────────────────────────────────────────────── */
async function exportCopy(clips, { onProgress, cancelled }) {
  const output = newOutput();
  const first = clips[0];
  const videoSource = new EncodedVideoPacketSource(first.codec);
  output.addVideoTrack(videoSource, { rotation: first.rotation });

  const withAudio = clips.every(c => c.audio && c.audioKey && c.audioKey === first.audioKey);
  let audioSource = null;
  if (withAudio) {
    audioSource = new EncodedAudioPacketSource(await first.audio.getCodec());
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const total = totalLength(clips) || 1;
  let offset = 0, done = 0;
  const snapped = [];
  for (const clip of clips) {
    const sink = new EncodedPacketSink(clip.video);
    const key = await sink.getKeyPacket(clip.in, { verifyKeyPackets: true });
    const startTs = key ? key.timestamp : 0;
    snapped.push(startTs);
    const meta = { decoderConfig: await clip.video.getDecoderConfig() };
    let end = startTs;
    for await (const p of sink.packets(key ?? undefined, undefined, { verifyKeyPackets: true })) {
      if (cancelled?.()) throw new Error("Export cancelled.");
      if (p.timestamp >= clip.out) break;
      await videoSource.add(p.clone({ timestamp: p.timestamp - startTs + offset }), meta);
      end = Math.max(end, p.timestamp + p.duration);
      onProgress?.((done + (p.timestamp - startTs)) / total);
    }
    if (audioSource) await pumpAudio(clip, audioSource, startTs, offset, clip.out);
    const used = Math.max(0, end - startTs);
    offset += used;
    done += used;
  }
  return { blob: await finish(output), snapped };
}

/* ── The render path ──────────────────────────────────────────────────────── */
/* Every frame goes source → canvas (rotation and aspect resolved) → the shared
   WebGL pass (colour, curves, hue bands, crop, straighten) → encoder. The
   editor's own preview canvas is not used: a hidden one is, at the output's
   true size, so what the seller was watching stays on screen while the export
   runs. */
async function exportRender(clips, recipe, { onProgress, cancelled, quantizer }) {
  const first = clips[0];
  const box = cropGeometry({ w: first.width, h: first.height }, recipe.geo);
  const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(box.w, box.h));
  const even = v => Math.max(2, 2 * Math.round((v * scale) / 2));
  const outW = even(box.w), outH = even(box.h);

  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = createPipeline(canvas);
  if (!ctx) throw new Error("This browser has no WebGL, so the video can't be rendered here.");

  const codec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"], { width: outW, height: outH });
  if (!codec) throw new Error("This browser can't encode video. Chrome, Edge or Safari 17+ can.");
  /* A quantizer rather than a bitrate: these are static shots of a small object
     on a plain sweep, and a bitrate target would spend the same bits on a still
     frame as on a moving one. The bitrate is only there as the fallback for
     encoders that won't take a quantizer. */
  const quality = new Quality({ quantizer, bitrate: Math.round(outW * outH * 0.22 * (first.fps || 30)) });
  const videoSource = new VideoSampleSource({ codec, quality, keyFrameInterval: 2, sizeChangeBehavior: "passThrough" });

  const output = newOutput();
  output.addVideoTrack(videoSource);
  const withAudio = !recipe.muted && clips.every(c => c.audio && c.audioKey && c.audioKey === first.audioKey);
  let audioSource = null;
  if (withAudio) {
    audioSource = new EncodedAudioPacketSource(await first.audio.getCodec());
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const total = totalLength(clips) || 1;
  let offset = 0, done = 0;
  try {
    for (const clip of clips) {
      const sink = frameSink(clip);
      let end = clip.in;
      for await (const frame of sink.canvases(clip.in, clip.out)) {
        if (cancelled?.()) throw new Error("Export cancelled.");
        setPipelineSource(ctx, frame.canvas);
        renderPipeline(ctx, canvas, {
          sw: frame.canvas.width, sh: frame.canvas.height,
          values: recipe.adjust, bands: recipe.bands, curves: recipe.curves,
          geo: recipe.geo, outW, outH,
        });
        const sample = new VideoSample(canvas, {
          timestamp: offset + Math.max(0, frame.timestamp - clip.in),
          duration: frame.duration,
        });
        await videoSource.add(sample);
        sample.close();
        end = Math.max(end, frame.timestamp + frame.duration);
        onProgress?.((done + (frame.timestamp - clip.in)) / total);
      }
      if (audioSource) await pumpAudio(clip, audioSource, clip.in, offset, clip.out);
      const used = Math.max(0, Math.min(end, clip.out) - clip.in);
      offset += used;
      done += used;
    }
    return { blob: await finish(output), snapped: clips.map(c => c.in) };
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
}

/* The one entry point. `recipe` carries the colour and geometry the editor is
   showing; when nothing in it has been touched and the clips agree, this
   returns the original frames in a new box. */
export async function exportVideo({ clips, recipe, quantizer = 20, onProgress, cancelled }) {
  if (!clips.length) throw new Error("There's nothing to export.");
  const copy = canCopy({ clips, recipeTouched: recipe.touched });
  const result = copy.ok
    ? await exportCopy(clips, { onProgress, cancelled })
    : await exportRender(clips, recipe, { onProgress, cancelled, quantizer });
  onProgress?.(1);
  return { ...result, lossless: copy.ok, why: copy.why };
}
