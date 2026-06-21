import cv2, os, sys, numpy as np

# Build frame-numbered montage grids from a video, dropping the last `drop_sec`.
# Sampling every `step` frames. Tiles `cols`x`rows` per montage image.
def montage(path, outdir, tag, step=3, drop_sec=2.0, cols=4, rows=6, thumb_w=300):
    c = cv2.VideoCapture(path)
    fps = c.get(cv2.CAP_PROP_FPS)
    total = int(c.get(cv2.CAP_PROP_FRAME_COUNT))
    last = total - int(round(drop_sec * fps))
    idxs = list(range(0, last, step))
    os.makedirs(outdir, exist_ok=True)
    # read needed frames
    frames = {}
    i = 0
    want = set(idxs)
    while True:
        ok, fr = c.read()
        if not ok:
            break
        if i in want:
            h, w = fr.shape[:2]
            th = int(thumb_w * h / w)
            t = cv2.resize(fr, (thumb_w, th))
            cv2.putText(t, '#%d' % i, (6, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                        (0, 255, 0), 2, cv2.LINE_AA)
            frames[i] = t
        i += 1
        if i >= last:
            break
    c.release()
    per = cols * rows
    th = frames[idxs[0]].shape[0]
    tw = thumb_w
    pad = 4
    mcount = 0
    for start in range(0, len(idxs), per):
        chunk = idxs[start:start + per]
        canvas = np.zeros(((th + pad) * rows + pad, (tw + pad) * cols + pad, 3), np.uint8)
        for k, fi in enumerate(chunk):
            r = k // cols
            cc = k % cols
            y = pad + r * (th + pad)
            x = pad + cc * (tw + pad)
            canvas[y:y + th, x:x + tw] = frames[fi]
        out = os.path.join(outdir, '%s_m%02d.jpg' % (tag, mcount))
        cv2.imwrite(out, canvas, [cv2.IMWRITE_JPEG_QUALITY, 80])
        print(out, 'frames', chunk[0], '-', chunk[-1])
        mcount += 1

if __name__ == '__main__':
    base = r'P:\My Documents\Claude Code\RadialDeck\build\frames'
    montage(r'C:\Users\djjac\Videos\2026-06-20 19-06-57.mp4', base, 'v1')
    montage(r'C:\Users\djjac\Videos\2026-06-20 19-06-04.mp4', base, 'v2')
