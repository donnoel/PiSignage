export function isStillClipFileName(fileName: string): boolean {
  return /\.still-\d+s(?:-\d+)?\.mp4$/i.test(fileName);
}

export function isPlaybackSafeVideoFileName(fileName: string): boolean {
  return (
    /\.signage-720p(?:-\d+)?\.mp4$/i.test(fileName) ||
    /\.transcoded(?:-\d+)?\.mp4$/i.test(fileName) ||
    isStillClipFileName(fileName)
  );
}
