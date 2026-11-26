export function fileSize(bytes: number) {
  for (const [size, unit] of [
    [1e9, "GB"],
    [1e6, "MB"],
    [1e3, "KB"],
    [1, "B"],
  ] as const) {
    if (bytes >= size || size === 1)
      return `${(bytes / size).toLocaleString(undefined, { maximumFractionDigits: size === 1 ? 0 : 1 })} ${unit}`;
  }
}
