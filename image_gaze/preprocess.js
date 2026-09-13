/* Deterministic image-input adapter only. This module performs no gaze inference.
 * ROI equations adapted from GazeFollower / GC Zhu, CC BY-NC-SA 4.0.
 * Pinned source and attribution: ./README.md and ../image-model/upstream/LICENSE-CC-BY-NC-SA.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MGazePreprocess = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const contract = Object.freeze({
    id: 'gazefollower-mgazenet-image-input-v1',
    upstreamFile: 'gazefollower/gaze_estimator/MGazeNetGazeEstimator.py',
    upstreamCommit: '7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa',
    sourcePixels: 'Unpremultiplied RGBA uint8; alpha is ignored. RGB byte order is preserved.',
    rectangleFormat: 'Integer source-image pixel coordinates {x,y,width,height}; right and bottom bounds are exclusive.',
    tensorLayout: 'NHWC', normalization: 'RGB uint8 / 255, stored as float32',
    faceShape: Object.freeze([1, 224, 224, 3]), eyeShape: Object.freeze([1, 112, 112, 3]), rectShape: Object.freeze([1, 12]),
    rectOrder: Object.freeze(['face.width/W','face.height/H','face.x/W','face.y/H',
      'leftEye.width/W','leftEye.height/H','leftEye.x/W','leftEye.y/H',
      'rightEye.width/W','rightEye.height/H','rightEye.x/W','rightEye.y/H']),
    rightEyeFlip: 'Horizontal flip after resize, as in the upstream estimator.',
    resize: 'Half-pixel bilinear interpolation, clamp to crop edges, round to nearest uint8 with half ties upward.',
    numericalLimit: 'Not bit-exact OpenCV INTER_LINEAR: the checked OpenCV 4.14 synthetic fixtures differ by at most 2 uint8 levels (2/255 before float32 rounding). This observed bound is not a guarantee for every image/backend.',
    mirrorRule: 'If sourceMirrored=true, both the pixels and all rectangles are expressed in the mirrored source. Restore canonical orientation without swapping model eye labels before the model-specific right-eye flip.'
  });
  const integer = value => typeof value === 'number' && Number.isSafeInteger(value);
  const LEFT_VERTICES = Object.freeze([33,246,161,160,159,158,157,173,133,155,154,153,145,144,163,7,33]);
  const RIGHT_VERTICES = Object.freeze([362,388,384,385,386,387,388,466,263,249,380,373,374,380,381,382,362]);
  const LIP_VERTICES = Object.freeze([61,91,14,178,402,324,95]);
  function roundEven(value) {
    const lower = Math.floor(value), fraction = value - lower;
    const result = fraction === .5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value);
    return result === 0 ? 0 : result;
  }
  function roisFromLandmarks(landmarks, width, height) {
    const reject = reason => ({ ok: false, reason });
    if (!integer(width) || !integer(height) || width <= 0 || height <= 0 || width > 32767 || height > 32767) return reject('invalid_source_dimensions');
    if (!Array.isArray(landmarks) || landmarks.length !== 478) return reject('expected_478_landmarks');
    if (!landmarks.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return reject('invalid_landmark_coordinates');
    // Python uses np.round (ties to even), then int16 pixels. Reject overflow
    // explicitly instead of allowing the upstream int16 wrap-around on corrupt input.
    const points = landmarks.map(p => ({ x: roundEven(p.x * width), y: roundEven(p.y * height) }));
    if (points.some(p => p.x < -32768 || p.x > 32767 || p.y < -32768 || p.y > 32767)) return reject('landmark_int16_overflow');
    let minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    let minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > width) maxX = width;
    if (maxY > height) maxY = height;
    const lipY = LIP_VERTICES.reduce((sum, index) => sum + points[index].y, 0) / LIP_VERTICES.length;
    if (lipY >= height) return reject('lip_out_of_frame');
    const delta = (Math.abs(minX - maxX) - Math.abs(minY - maxY)) / 4;
    let fx0 = minX + delta, fy0 = minY - delta, fx1 = maxX - delta, fy1 = maxY + delta;
    // These asymmetric clamps reproduce the upstream face-box construction.
    if (fy1 > height) fy1 = height - 1;
    if (fy0 < 0) fy0 = 0;
    if (fx0 < 0) fx0 = 0;
    if (fx1 > width) fx1 = width - 1;
    [fx0,fy0,fx1,fy1] = [fx0,fy0,fx1,fy1].map(Math.trunc);
    const scale = Math.abs(points[362].x - points[133].x) / 100;
    function eye(first, second) {
      const x0 = points[first].x - 20 * scale, x1 = points[second].x + 20 * scale;
      const eyeHeight = Math.abs(x0 - x1) * .75, middleY = (points[first].y + points[second].y) / 2;
      return [Math.trunc(x0), Math.trunc(middleY - eyeHeight * .6), Math.trunc(x1), Math.trunc(middleY + eyeHeight * .4)];
    }
    const left = eye(33,133), right = eye(362,263);
    const outside = r => r[0] <= 0 || r[1] <= 0 || r[2] >= width || r[3] >= height;
    if (outside(left)) return reject('left_eye_out_of_frame');
    if (outside(right)) return reject('right_eye_out_of_frame');
    const toRect = r => ({ x:r[0], y:r[1], width:r[2]-r[0], height:r[3]-r[1] });
    const face = toRect([fx0,fy0,fx1,fy1]), leftEye = toRect(left), rightEye = toRect(right);
    // Reject empty/inverted ROIs rather than producing empty images or NaNs.
    if ([face,leftEye,rightEye].some(r => r.width <= 0 || r.height <= 0 || r.x < 0 || r.y < 0 || r.x+r.width > width || r.y+r.height > height)) return reject('invalid_roi_rectangle');
    const area = indices => Math.abs(indices.reduce((sum,index,i) => {
      const prior = points[indices[(i+indices.length-1)%indices.length]], current = points[index];
      return sum + current.x * prior.y - current.y * prior.x;
    },0)) / 2;
    return { ok:true, reason:null, face,leftEye,rightEye,
      diagnostics:{landmarkCount:478,leftEyeOpenness:area(LEFT_VERTICES),rightEyeOpenness:area(RIGHT_VERTICES),
        eyeLabelConvention:'Model left uses MediaPipe 33/133; model right uses 362/263. Labels are not inferred from CSS preview position.',
        sourceCoordinateSpace:'Unmirrored normalized FaceMesh coordinates',rounding:'numpy ties-to-even pixels, then Python int truncation of ROI corners'} };
  }
  function imageSource(options) {
    if (!options || typeof options !== 'object') throw new TypeError('Image options are required');
    const { rgba, width, height } = options;
    if (!integer(width) || !integer(height) || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height * 4)) {
      throw new RangeError('Source width and height must be positive safe integers');
    }
    if (!ArrayBuffer.isView(rgba) || !['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(Object.prototype.toString.call(rgba))) {
      throw new TypeError('Source rgba must contain uint8 RGBA pixels');
    }
    if (rgba.length !== width * height * 4) throw new RangeError('Source rgba length does not match width × height × 4');
    const sourceMirrored = options.sourceMirrored === undefined ? false : options.sourceMirrored;
    if (typeof sourceMirrored !== 'boolean') throw new TypeError('sourceMirrored must be a boolean');
    return { rgba, width, height, sourceMirrored };
  }
  function rectangle(rect, source, name) {
    if (!rect || typeof rect !== 'object') throw new TypeError(`${name} rectangle is required`);
    const { x, y, width, height } = rect;
    if (![x,y,width,height].every(integer) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x + width > source.width || y + height > source.height) {
      throw new RangeError(`${name} must be a nonempty integer rectangle fully inside the source image`);
    }
    return Object.freeze({ x: source.sourceMirrored ? source.width - x - width : x, y, width, height });
  }
  function sourcePixel(source, rect, x, y, channel) {
    const canonicalX = rect.x + x;
    const sourceX = source.sourceMirrored ? source.width - 1 - canonicalX : canonicalX;
    return source.rgba[((rect.y + y) * source.width + sourceX) * 4 + channel];
  }
  function resizeCanonicalCrop(source, rect, outputWidth, outputHeight, flipX) {
    const result = new Uint8Array(outputWidth * outputHeight * 3);
    for (let y = 0; y < outputHeight; y++) {
      const sy = Math.max(0, Math.min(rect.height - 1, (y + .5) * rect.height / outputHeight - .5));
      const y0 = Math.floor(sy), y1 = Math.min(rect.height - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < outputWidth; x++) {
        const sx = Math.max(0, Math.min(rect.width - 1, (x + .5) * rect.width / outputWidth - .5));
        const x0 = Math.floor(sx), x1 = Math.min(rect.width - 1, x0 + 1), fx = sx - x0;
        const offset = (y * outputWidth + (flipX ? outputWidth - 1 - x : x)) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const top = sourcePixel(source, rect, x0, y0, channel) * (1 - fx) + sourcePixel(source, rect, x1, y0, channel) * fx;
          const bottom = sourcePixel(source, rect, x0, y1, channel) * (1 - fx) + sourcePixel(source, rect, x1, y1, channel) * fx;
          result[offset + channel] = Math.round(top * (1 - fy) + bottom * fy);
        }
      }
    }
    return result;
  }
  // Exported to make the crop/resize operator independently testable at small sizes.
  function resizeRgbCrop(options, rect, outputWidth, outputHeight, flipX = false) {
    const source = imageSource(options), crop = rectangle(rect, source, 'Crop');
    if (!integer(outputWidth) || !integer(outputHeight) || outputWidth <= 0 || outputHeight <= 0 ||
        !Number.isSafeInteger(outputWidth * outputHeight * 3)) throw new RangeError('Output dimensions must be positive safe integers');
    if (typeof flipX !== 'boolean') throw new TypeError('flipX must be a boolean');
    return resizeCanonicalCrop(source, crop, outputWidth, outputHeight, flipX);
  }
  function tensor(bytes, shape) {
    const data = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) data[i] = bytes[i] / 255;
    return { data, shape: shape.slice() };
  }
  function prepareInputs(options) {
    const source = imageSource(options);
    const face = rectangle(options.face, source, 'Face');
    const leftEye = rectangle(options.leftEye, source, 'Left eye');
    const rightEye = rectangle(options.rightEye, source, 'Right eye');
    const rect = new Float32Array([face, leftEye, rightEye].flatMap(r =>
      [r.width / source.width, r.height / source.height, r.x / source.width, r.y / source.height]));
    return {
      face: tensor(resizeCanonicalCrop(source, face, 224, 224, false), contract.faceShape),
      left: tensor(resizeCanonicalCrop(source, leftEye, 112, 112, false), contract.eyeShape),
      right: tensor(resizeCanonicalCrop(source, rightEye, 112, 112, true), contract.eyeShape),
      rect: { data: rect, shape: contract.rectShape.slice() },
      metadata: {
        contractId: contract.id,
        sourceImage: { width: source.width, height: source.height, format: 'RGBA_UINT8', sourceMirrored: source.sourceMirrored },
        canonicalRectangles: { face, leftEye, rightEye },
        tensorLayout: contract.tensorLayout, normalization: contract.normalization,
        resize: contract.resize, rightEyeFlip: true,
        numericalLimit: contract.numericalLimit,
        coordinateSpace: 'Source image pixels; viewport dimensions and CSS mirroring are not used.',
        inferencePerformed: false
      }
    };
  }
  return Object.freeze({ contract, prepareInputs, resizeRgbCrop, roisFromLandmarks });
}));
