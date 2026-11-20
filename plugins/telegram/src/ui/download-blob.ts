export function downloadBlob(blob: Blob, filename: string) {
  const download = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  const revoke = URL.revokeObjectURL.bind(URL);
  download.href = objectUrl;
  download.download = filename;
  try {
    document.body.append(download);
    download.click();
  } finally {
    download.remove();
    setTimeout(() => revoke(objectUrl), 30_000);
  }
}
