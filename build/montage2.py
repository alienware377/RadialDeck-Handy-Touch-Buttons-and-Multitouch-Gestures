import cv2, os, numpy as np

def montage(path, outdir, tag, step=3, drop_sec=2.0, cols=4, rows=6, thumb_w=300):
    c = cv2.VideoCapture(path)
    fps = c.get(cv2.CAP_PROP_FPS)
    total = int(c.get(cv2.CAP_PROP_FRAME_COUNT))
    last = total - int(round(drop_sec * fps))
    idxs = list(range(0, last, step))
    os.makedirs(outdir, exist_ok=True)
    frames = {}
    want = set(idxs)
    i = 0
    while True:
        ok, fr = c.read()
        if not ok or i >= last:
            break
        if i in want:
            h, w = fr.shape[:2]
            th = int(thumb_w * h / w)
            t = cv2.resize(fr, (thumb_w, th))
            cv2.putText(t, '#%d' % i, (6, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                        (0, 255, 0), 2, cv2.LINE_AA)
            frames[i] = t
        i += 1
    c.release()
    per = cols * rows
    th = frames[idxs[0]].shape[0]; tw = thumb_w; pad = 4
    m = 0
    for s in range(0, len(idxs), per):
        chunk = idxs[s:s + per]
        canvas = np.zeros(((th + pad) * rows + pad, (tw + pad) * cols + pad, 3), np.uint8)
        for k, fi in enumerate(chunk):
            r = k // cols; cc = k % cols
            y = pad + r * (th + pad); x = pad + cc * (tw + pad)
            canvas[y:y + th, x:x + tw] = frames[fi]
        out = os.path.join(outdir, '%s_m%02d.jpg' % (tag, m))
        cv2.imwrite(out, canvas, [cv2.IMWRITE_JPEG_QUALITY, 80])
        print(out, chunk[0], '-', chunk[-1]); m += 1

montage(r'C:\Users\djjac\Videos\2026-06-20 19-42-51.mp4',
        r'P:\My Documents\Claude Code\RadialDeck\build\frames3', 'v3')
