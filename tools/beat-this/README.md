# beat-this

The analyzer's optional downbeat tracker: [Beat This!](https://github.com/CPJKU/beat_this)
(Foscarin, Schlüter and Widmer, ISMIR 2024) exported to ONNX, so the lean
analyzer image can run it with onnxruntime and no torch. With
`ANALYZE_DOWNBEATS=beat-this` the worker (`controller/scripts/analyze_worker.py`,
`DownbeatTracker`) takes the bar grid from it instead of librosa's every-4th-beat
guess. These scripts are how the model is made and how that switch was judged.
Nothing here runs on a station.

| File | Runs in | What it does |
| --- | --- | --- |
| `export.py` | export venv (torch) | sha256-checks a checkpoint, exports it to ONNX, fails unless onnxruntime reproduces PyTorch's logits on real audio |
| `parity.py` | export venv (torch) | the worker's whole torch-free pipeline against upstream `File2Beats(dbn=False)`, per file |
| `evaluate.py` | eval venv (no torch) | today's grid, `small0` and `final0` against GTZAN's human downbeat labels |
| `cost.py` | eval venv (no torch) | one fresh-process cost sample: import, session, peak RSS, seconds per window |

## Pins

| What | Pin |
| --- | --- |
| beat_this | v1.1.0, commit `ad7974846029835307ba19a3d5cefbf40b243041` |
| `small0` checkpoint | `https://f0k.de/pubs/2024_ismir/beat_this-small0.ckpt`, sha256 `6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b` |
| `final0` checkpoint | `https://f0k.de/pubs/2024_ismir/beat_this-final0.ckpt`, sha256 `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331` |
| export venv | Python 3.11, CPU torch 2.7.1, torchaudio 2.7.1, einops 0.8.0, rotary-embedding-torch 0.6.4, soxr 1.1.0, soundfile 0.14.0, onnx 1.18.0, onnxruntime 1.27.0 |
| eval venv | Python 3.11, librosa 0.11.0, soundfile 0.14.0, pyloudnorm 0.2.0, onnxruntime 1.27.0, mir_eval 0.8.2 |
| parity audio | upstream's `tests/It Don't Mean A Thing - Kings of Swing.mp3` at that commit, sha256 `af695e220645a1fe2314282dace96f2353c84de2364c27066e4944e3e6d66ffa` |

The checkpoints come from the maintainer's mirror. Upstream's own host
(`cloud.cp.jku.at`) has had outages (upstream issues #19, #20, #23). There is
no official ONNX export (upstream #12), and the community exports are not used:
the model the analyzer runs is the one this script produces.

## Export

```bash
uv venv -p 3.11 /tmp/bt/export
uv pip install -p /tmp/bt/export/bin/python \
  --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
  --index-strategy unsafe-best-match \
  torch==2.7.1 torchaudio==2.7.1 einops==0.8.0 rotary-embedding-torch==0.6.4 soxr==1.1.0 \
  soundfile==0.14.0 onnx==1.18.0 onnxruntime==1.27.0 librosa==0.11.0 \
  "beat_this @ git+https://github.com/CPJKU/beat_this@ad7974846029835307ba19a3d5cefbf40b243041"
curl -fLo /tmp/bt/small0.ckpt https://f0k.de/pubs/2024_ismir/beat_this-small0.ckpt
/tmp/bt/export/bin/python tools/beat-this/export.py --ckpt /tmp/bt/small0.ckpt \
  --sha256 6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b \
  --out /tmp/bt/beat_this-small0.onnx --audio "/path/to/Kings of Swing.mp3"
```

The images run exactly this in a builder stage (`docker/Dockerfile.analyzer`,
`docker/Dockerfile.aio`) and copy only the `.onnx` into the final stage.

Export choices:

- **Opset 17.** It is the TorchScript exporter's default in torch 2.7, nothing
  in the graph needs a newer operator, and onnxruntime 1.27 runs it on every
  platform the analyzer ships for.
- **Input `spect`, shape `(1, frames, 128)`, frames dynamic, at most 1500.**
  Upstream feeds the model 1500-frame chunks (30 s at 50 fps) and a single
  shorter chunk for a piece under 30 s, which is every 20 s tail window. A
  fixed 1500-frame input would have to zero-pad that short chunk, and the
  attention would then see frames upstream never shows it. The rotary position
  table is baked for 1500 positions, so longer input is not supported; the
  worker never sends any.
- **Outputs `beat` and `downbeat`, shape `(1, frames)`, logits.**
- **Time-direction attention runs two maps at a time** (`--attn-group 2`,
  the default). Every attention along time builds a frames × frames score map
  per sequence and head. Each of the three frontend blocks runs 32 of them at
  once (one per frequency band and head): at 1500 frames that is a 288 MB
  float32 score tensor plus its softmax, live together, in `small0` and
  `final0` alike. Attention never mixes maps, so the export computes them two
  at a time, after the rotary embedding, with the same arithmetic. The
  frequency-direction attention (8 to 32 positions) keeps upstream's
  `scaled_dot_product_attention` call. `--attn-group 0` exports upstream's
  graph unchanged, and the parity check always compares against the unpatched
  PyTorch model. An earlier version split whole sequences instead, which
  duplicated the rotary subgraph per slice (21,700 nodes, a 5.6 s session
  load) for a smaller saving.

Exported here (torch 2.7.1+cpu, onnx IR 8):

| | `small0` | `final0` |
| --- | --- | --- |
| Parameters | 2,099,960 | 20,251,712 |
| File | 9,588,293 bytes, 5,012 nodes | 82,236,463 bytes, 5,156 nodes |
| sha256 | `5cff50fb031bc4a43b036f0af4835cf60bf8d43e6ccc8a7e676ed89db53f6eaf` | `6ea0954f813f58cd945bd9215c0ed39330e811baa428ede6576bc32149eca965` |
| Max abs logit diff vs PyTorch (12 chunks of 1500, 1013, 512 and 1237 frames) | 6.39e-05 | 7.72e-05 |

Two exports on the same machine were byte-identical. The hash is a record, not
a gate: the build gate is the logit parity, because a different CPU or torch
build may fold constants into different bits.

## Parity with upstream

`parity.py` runs upstream's `File2Beats(dbn=False)` and the worker's
`DownbeatTracker` on the same files and compares beat and downbeat times.

On 34 files, 22050 Hz PCM so both sides read identical samples (30 GTZAN
clips, three per genre; 12, 20 and 40 s cuts, covering one short chunk and two
overlapping chunks; and upstream's full 155 s test song, several chunks):

| | Files | Beats | Downbeats | Identical | Within one frame | Length mismatches |
| --- | --- | --- | --- | --- | --- | --- |
| `small0` | 34 | 2,629 | 784 | 34 / 34 | 34 / 34 | 0 |
| `final0` | 34 | 2,604 | 733 | 34 / 34 | 34 / 34 | 0 |

The numpy log-mel matches `LogMelSpect` to 1.1–1.8e-04 (values up to 8.3).

The front end is librosa's STFT with a periodic Hann window, `center=True`
reflect padding, magnitude divided by √1024, then
`librosa.filters.mel(sr=22050, n_fft=1024, n_mels=128, fmin=30, fmax=11000,
htk=False, norm=None)`. torchaudio's `MelSpectrogram` uses the slaney mel
scale without area normalisation, so `norm=None` is the match; `norm="slaney"`
is not. Nothing extra ships: the filterbank is computed at load.

## Evaluation (GTZAN)

Upstream trained every `small*` and `final*` checkpoint on everything except
GTZAN (its README, and `test_dataset: gtzan` in `final0`'s own
hyperparameters), so GTZAN is a fair held-out test. Labels are GTZAN-Rhythm
(Marchand and Peeters), from `github.com/TempoBeatDownbeat/gtzan_tempo_beat` at
`fd9cafdebb6426fee41c3718791be61306323dd7`. Audio is the Hugging Face
`marsyas/gtzan` tarball (`data/genres.tar.gz`, sha256
`b28cc067ff6199bd826f5d1a6931458586d64acae7f44b2e882b7a97af057531`), with its
macOS `._*` files removed.

```bash
python tools/beat-this/evaluate.py run   genres/ models/ results.jsonl --procs 3
python tools/beat-this/evaluate.py score results.jsonl gtzan_tempo_beat/ metrics.json
```

All 1,000 clips, with two skipped: `jazz_00054` does not decode, and
`reggae_00086` has no annotation. Six jazz clips carry beat times without
positions, so they count for beats only. Columns are a = today's grid,
b = `small0`, c = `final0`; the metrics are defined in `evaluate.py`'s header.

| Genre | n (beats / downbeats) | Downbeat F a / b / c | Bar precision a / b / c | Blend-cue hit a / b / c | Beat F a / b / c | BPM within 4% a / b / c | Octave errors a / b / c |
| --- | --- | --- | --- | --- | --- | --- | --- |
| blues | 100 / 100 | 13.3 / 63.3 / 63.9 | 13.9 / 58.4 / 59.6 | 12.0 / 50.0 / 57.0 | 66.6 / 81.1 / 83.1 | 65.0 / 73.0 / 72.0 | 18.0 / 15.0 / 15.0 |
| classical | 100 / 100 | 23.5 / 47.1 / 51.4 | 24.8 / 39.5 / 44.3 | 12.0 / 25.0 / 33.0 | 57.2 / 65.0 / 65.9 | 46.0 / 49.0 / 54.0 | 19.0 / 17.0 / 17.0 |
| country | 100 / 100 | 11.8 / 90.3 / 91.5 | 12.2 / 88.1 / 89.6 | 10.0 / 88.0 / 88.0 | 82.6 / 91.9 / 94.4 | 69.0 / 83.0 / 88.0 | 27.0 / 12.0 / 9.0 |
| disco | 100 / 100 | 19.4 / 94.0 / 93.6 | 19.6 / 92.9 / 93.2 | 20.0 / 91.0 / 94.0 | 91.9 / 96.9 / 96.6 | 93.0 / 96.0 / 95.0 | 3.0 / 2.0 / 2.0 |
| hiphop | 100 / 100 | 10.1 / 87.9 / 89.8 | 9.8 / 86.1 / 87.8 | 9.0 / 86.0 / 89.0 | 82.6 / 97.6 / 97.5 | 76.0 / 95.0 / 95.0 | 13.0 / 2.0 / 3.0 |
| jazz | 99 / 93 | 8.5 / 70.4 / 74.7 | 9.0 / 64.2 / 70.2 | 5.4 / 54.8 / 65.6 | 60.6 / 85.6 / 86.9 | 55.6 / 74.7 / 75.8 | 27.3 / 15.2 / 13.1 |
| metal | 100 / 100 | 10.9 / 78.4 / 76.9 | 10.8 / 74.4 / 72.0 | 9.0 / 70.0 / 66.0 | 79.6 / 88.7 / 87.7 | 62.0 / 80.0 / 80.0 | 26.0 / 9.0 / 11.0 |
| pop | 100 / 100 | 16.2 / 91.7 / 93.9 | 16.3 / 89.8 / 92.5 | 15.0 / 91.0 / 92.0 | 77.8 / 94.6 / 95.3 | 73.0 / 90.0 / 92.0 | 15.0 / 7.0 / 6.0 |
| reggae | 99 / 99 | 11.9 / 66.9 / 68.8 | 13.1 / 67.4 / 69.4 | 14.1 / 60.6 / 64.6 | 81.8 / 90.6 / 90.7 | 70.7 / 74.7 / 75.8 | 25.3 / 23.2 / 23.2 |
| rock | 100 / 100 | 12.8 / 81.7 / 82.1 | 12.7 / 78.3 / 79.5 | 12.0 / 74.0 / 77.0 | 79.2 / 92.9 / 93.0 | 76.0 / 93.0 / 89.0 | 14.0 / 5.0 / 6.0 |
| **overall** | 998 / 992 | 13.9 / 77.2 / 78.7 | 14.3 / 74.0 / 75.9 | 11.9 / 69.2 / 72.7 | 76.0 / 88.5 / 89.1 | 68.6 / 80.9 / 81.7 | 18.7 / 10.7 / 10.5 |

Today's grid puts both blend cues on a real downbeat for 11.9% of clips;
`small0` does it for 69.2%.

## Cost

Each sample is a fresh process (`cost.py`) on a 12-vCPU QEMU VM shared with
other work (load ~2.7). Python 3.11, onnxruntime 1.27.0. Peak RSS is VmHWM
minus that of a numpy + librosa process doing the same decode and `beat_track`
(281.6 MiB). Window times are medians of three calls on the whole tracker,
including the front end and postprocessing.

| Graph | Threads | Session load | Peak RSS increase | 30 s window | 40 s window |
| --- | --- | --- | --- | --- | --- |
| `small0` (shipped) | 1 / 2 / 4 | 0.50 s | +227 / +225 / +226 MB | 3.92 / 2.14 / 1.19 s | 3.87 / 2.15 / 1.20 s |
| `small0`, `--attn-group 0` | 2 | 0.32 s | +1,347 MB | 2.11 s | 2.12 s |
| `final0` (shipped) | 1 / 2 / 4 | 0.73 s | +333 / +333 / +338 MB | 7.82 / 4.19 / 2.33 s | 7.89 / 4.14 / 2.37 s |
| `final0`, `--attn-group 0` | 2 | 0.41 s | +1,456 MB | 4.15 s | 4.10 s |

librosa's `beat_track` takes 0.05 s on the same 40 s window. Disabling
onnxruntime's CPU arena raised `small0`'s peak to +394 MB (glibc keeps the
freed blocks), so the worker keeps the arena, and the memory stays held until
the idle release. onnxruntime adds 53 MiB to the lean venv on amd64 and
46 MiB on arm64 (onnxruntime, protobuf, flatbuffers); 1.27.0 resolves for
cp311 and cp313 on both.

## Hosting the model

Today both images export the model in a `--platform=$BUILDPLATFORM` builder
stage, so every image build downloads CPU torch and the checkpoint from
`f0k.de`. The alternatives, for the maintainer:

| Option | Build depends on | Trade-off |
| --- | --- | --- |
| Builder stage (current) | f0k.de, the PyTorch wheel index, GitHub | Reproducible from source on every build, and the parity check runs every time. Each build pays ~1 GB of downloads and a minute of export, and a mirror outage breaks image builds (not stations). |
| GitHub release asset on this repo | GitHub only, which the build already needs | `ADD --checksum=sha256:…` of a 9.6 MB file: fast, and the hash pins exactly what ships. Somebody runs `export.py` once per model change and uploads the file. |
| Hugging Face repo | huggingface.co | Same shape as a release asset. The heavy tier already depends on HF at run time, but the lean tier never has. |
| Git LFS, or the file committed | GitHub LFS quotas, or nothing | LFS needs setup in every clone and CI job and has bandwidth quotas. A plain commit is simplest, but every model update adds ~10 MB to history for good. |

## Licence

Beat This! code and weights are MIT (see `CREDITS.md`). The maintainers have
said commercial use and redistribution are fine (upstream #21). The training
data includes commercial recordings, and the question of what that means for
the weights is still open upstream (#18). Read both before turning this on by
default anywhere; nothing here is a licence clearance.
