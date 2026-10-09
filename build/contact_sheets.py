"""Contact sheets of clip thumbnails (numbered tiles) so a reviewer can mark
which clips show the creator on camera (anything else goes in config.exclude_video_ids).
Usage: python build/contact_sheets.py creators/<slug>/unscreened.json <outdir>   (needs Pillow)
(or corpus.json). Record the verdicts in creators/<slug>/screened.json.
Writes sheet_NN.png (6x5 = 30 tiles each) and index.json mapping tile number -> youtube id/title."""
import json, sys, io, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

corpus, out = sys.argv[1], sys.argv[2]
data = json.load(open(corpus, encoding="utf8"))
clips = data["clips"] if isinstance(data, dict) else data  # corpus.json, or unscreened.json from build/index.mjs
os.makedirs(out, exist_ok=True)
W, H, COLS, ROWS = 240, 135, 6, 5

def thumb(c):
    try:
        data = urllib.request.urlopen(f"https://i.ytimg.com/vi/{c['youtube_id']}/mqdefault.jpg", timeout=20).read()
        return Image.open(io.BytesIO(data)).convert("RGB").resize((W, H))
    except Exception:
        return Image.new("RGB", (W, H), (60, 0, 0))

with ThreadPoolExecutor(8) as ex:
    imgs = list(ex.map(thumb, clips))

font = ImageFont.load_default(size=26)
index = {}
per = COLS * ROWS
for s in range(0, len(clips), per):
    sheet = Image.new("RGB", (COLS * W, ROWS * H), "white")
    d = ImageDraw.Draw(sheet)
    for k, (c, im) in enumerate(zip(clips[s:s + per], imgs[s:s + per])):
        n = s + k
        x, y = (k % COLS) * W, (k // COLS) * H
        sheet.paste(im, (x, y))
        d.rectangle([x, y, x + 52, y + 32], fill="yellow")
        d.text((x + 4, y + 2), str(n), fill="black", font=font)
        index[n] = {"youtube_id": c["youtube_id"], "title": c["title"]}
    sheet.save(os.path.join(out, f"sheet_{s // per:02d}.png"))
json.dump(index, open(os.path.join(out, "index.json"), "w", encoding="utf8"), indent=0)
print(len(clips), "clips ->", (len(clips) + per - 1) // per, "sheets")
