const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${numberFormat.format(bytes)} B`;
  if (bytes < 1024 ** 2) return `${numberFormat.format(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${numberFormat.format(bytes / 1024 ** 2)} MiB`;
  return `${numberFormat.format(bytes / 1024 ** 3)} GiB`;
}
