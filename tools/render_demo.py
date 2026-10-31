"""Render a War Room run log into a terminal-style PNG and an MP4 replay (lines appear at their real timestamps)."""
import re, subprocess, sys, os, shutil
from PIL import Image, ImageDraw, ImageFont

log_path, out_prefix, title = sys.argv[1], sys.argv[2], sys.argv[3]
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 17)
BOLD = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 17)
W, H, LH, ROWS = 1600, 900, 24, 32
TAGS = {"🚨": ("[OPS] ", "#ff6b6b"), "▶": ("[RUN] ", "#7aa2f7"), "📌": ("[POST]", "#e0af68"), "✅": ("[ OK ]", "#9ece6a"),
        "❌": ("[REJ ]", "#f7768e"), "⛔": ("[GATE]", "#ff9e64"), "↻": ("[RTRY]", "#bb9af7"), "💬": ("[SAY ]", "#a9b1d6"),
        "🏁": ("[DONE]", "#73daca"), "⚠️": ("[WARN]", "#ff9e64"), "⏱": ("[TIME]", "#ff9e64")}

lines = []
for raw in open(log_path, encoding="utf8"):
    raw = raw.rstrip("\n")
    if raw.startswith("mozaik cloud") or raw.startswith(">") or not raw.strip():
        continue
    m = re.match(r"\s*(\d+)ms\s+(.*)", raw)
    t, text = (int(m.group(1)), m.group(2)) if m else (None, raw)
    tag, color = "", "#c0caf5"
    for k, (tg, c) in TAGS.items():
        if text.startswith(k):
            tag, color, text = tg, c, text[len(k):].strip()
            break
    lines.append((t, tag, color, text))
end_t = max(t for t, *_ in lines if t is not None)
lines = [(t if t is not None else end_t + 400, *r) for t, *r in lines]

def frame(visible):
    img = Image.new("RGB", (W, H), "#1a1b26")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 40], fill="#24283b")
    for i, c in enumerate(["#f7768e", "#e0af68", "#9ece6a"]):
        d.ellipse([16 + i * 26, 13, 30 + i * 26, 27], fill=c)
    d.text((110, 10), title, font=BOLD, fill="#c0caf5")
    y = 52
    for t, tag, color, text in visible[-ROWS:]:
        x = 16
        if tag:
            d.text((x, y), f"{t/1000:6.2f}s", font=FONT, fill="#565f89"); x += 90
            d.text((x, y), tag, font=BOLD, fill=color); x += 75
            d.text((x, y), text[:118], font=FONT, fill=color if tag in ("[REJ ]", "[GATE]", "[DONE]") else "#c0caf5")
        else:
            d.text((x, y), text[:150], font=BOLD if "Verified" in text else FONT, fill="#73daca" if "Verified" in text else "#a9b1d6")
        y += LH
    return img

frame(lines).save(out_prefix + ".png")
fps, tmp = 10, out_prefix + "_frames"
shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
total = lines[-1][0] + 3000
for i in range(int(total / 1000 * fps)):
    now = i * 1000 / fps
    frame([l for l in lines if l[0] <= now]).save(f"{tmp}/{i:05d}.png")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", f"{tmp}/%05d.png", "-c:v", "libx264", "-pix_fmt", "yuv420p", out_prefix + ".mp4"], check=True)
shutil.rmtree(tmp)
print("ok", out_prefix)
