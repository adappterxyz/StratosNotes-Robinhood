/* eslint-disable @typescript-eslint/no-explicit-any */
/** Fit the diagram, but never below a readable zoom (Flow's MIN_FIT_ZOOM): wide workflows start at the left and pan. */
export function fitReadable(canvas: any, min = 0.6) {
  canvas.zoom('fit-viewport');
  const vb = canvas.viewbox();
  if (vb.scale < min)
    canvas.viewbox({
      x: vb.inner.x - 20,
      y: vb.inner.y - 20,
      width: vb.outer.width / min,
      height: vb.outer.height / min,
    });
}
