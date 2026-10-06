const MEBIBYTE = 1024 * 1024;

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function readRuntimeMemory(scope = globalThis) {
  const memory = scope?.performance?.memory;
  return {
    jsHeapUsedBytes: nonNegativeNumber(memory?.usedJSHeapSize),
    jsHeapLimitBytes: nonNegativeNumber(memory?.jsHeapSizeLimit),
    deviceMemoryGb: nonNegativeNumber(scope?.navigator?.deviceMemory)
  };
}

export function getMemoryStatus({
  memorySamples = [],
  deviceMemoryGb = null,
  screenBufferedBytes = 0,
  screenBufferedFrames = 0,
  pendingCaptureCount = 0
} = {}) {
  const heapSamples = memorySamples
    .map((sample) => ({
      used: nonNegativeNumber(sample?.jsHeapUsedBytes),
      limit: nonNegativeNumber(sample?.jsHeapLimitBytes)
    }))
    .filter(({ used, limit }) => used !== null && limit > 0);
  const mostPressuredHeap = heapSamples.reduce((worst, sample) => {
    const ratio = sample.used / sample.limit;
    return !worst || ratio > worst.ratio ? { ...sample, ratio } : worst;
  }, null);
  const heapUsedRatio = mostPressuredHeap?.ratio ?? null;
  const estimatedHeapHeadroomBytes = mostPressuredHeap
    ? Math.max(0, mostPressuredHeap.limit - mostPressuredHeap.used)
    : null;
  const deviceMemory = nonNegativeNumber(deviceMemoryGb);
  const bufferedBytes = nonNegativeNumber(screenBufferedBytes) ?? 0;
  const bufferedFrames = nonNegativeNumber(screenBufferedFrames) ?? 0;
  const pendingCaptures = nonNegativeNumber(pendingCaptureCount) ?? 0;

  let level = 'normal';
  if (
    heapUsedRatio >= 0.9 ||
    bufferedBytes >= 192 * MEBIBYTE ||
    pendingCaptures >= 24 ||
    deviceMemory !== null && deviceMemory <= 2
  ) {
    level = 'high';
  } else if (
    heapUsedRatio >= 0.72 ||
    bufferedBytes >= 64 * MEBIBYTE ||
    pendingCaptures >= 8 ||
    deviceMemory !== null && deviceMemory <= 4
  ) {
    level = 'elevated';
  } else if (
    heapUsedRatio === null &&
    deviceMemory === null
  ) {
    level = 'unavailable';
  }

  return {
    level,
    memoryApiAvailable: heapUsedRatio !== null,
    heapUsedRatio,
    estimatedHeapHeadroomBytes,
    deviceMemoryGb: deviceMemory,
    screenBufferedBytes: bufferedBytes,
    screenBufferedFrames: bufferedFrames,
    pendingCaptureCount: pendingCaptures,
    maxPrebufferedCaptureFrames: level === 'high' ? 1 : level === 'elevated' ? 3 : level === 'unavailable' ? 4 : 10
  };
}