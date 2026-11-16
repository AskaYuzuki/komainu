# Instagram の複数枚投稿は、1枚目の比率(4:5)に全部の写真が切りそろえられる。
# 横向き・3:4 の写真が切れないよう、白地の 1080×1350 の中に写真全体を収める(11/16 あすかさん「横向き画像が切れてしまっている」)。
import sys, os
from PIL import Image, ImageOps
W, H = 1080, 1350
def pad(p):
    im = ImageOps.exif_transpose(Image.open(p)).convert('RGB')
    if im.size == (W, H): return False
    if abs(im.width / im.height - W / H) < 0.005:
        im.resize((W, H), Image.LANCZOS).save(p, quality=90); return True
    im.thumbnail((W, H), Image.LANCZOS)
    bg = Image.new('RGB', (W, H), (255, 255, 255))
    bg.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    if p.lower().endswith('.png'): bg.save(p)
    else: bg.save(p, quality=90)
    return True
for d in sys.argv[1:]:
    for f in sorted(os.listdir(d)):
        if f[:2].isdigit() and f.lower().endswith(('.jpg', '.jpeg', '.png')):
            if pad(f'{d}/{f}'): print('pad', d, f)
