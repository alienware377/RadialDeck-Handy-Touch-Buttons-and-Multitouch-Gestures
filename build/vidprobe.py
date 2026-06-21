import cv2, os
vids = [
    r'C:\Users\djjac\Videos\2026-06-20 19-06-57.mp4',
    r'C:\Users\djjac\Videos\2026-06-20 19-06-04.mp4',
]
for f in vids:
    c = cv2.VideoCapture(f)
    fps = c.get(cv2.CAP_PROP_FPS)
    n = c.get(cv2.CAP_PROP_FRAME_COUNT)
    w = c.get(cv2.CAP_PROP_FRAME_WIDTH)
    h = c.get(cv2.CAP_PROP_FRAME_HEIGHT)
    print(os.path.basename(f), 'fps=%.2f' % fps, 'frames=%d' % n,
          'dur=%.1fs' % (n / fps if fps else 0), '%dx%d' % (w, h))
    c.release()
