const LOCAL_PATH_RE =
  /(?:^|[\s(`])((?:\/(?:Users|Volumes|tmp|private\/tmp)\/[^\s`<>]+|~\/[^\s`<>]+))(?![\w])/g;

export function linkifyLocalPaths(content: string): string {
  return content.replace(LOCAL_PATH_RE, (match, path: string) => {
    const prefix = match.slice(0, match.length - path.length);
    const href = `buzz-local://open?path=${encodeURIComponent(path)}`;
    return `${prefix}[${path}](${href})`;
  });
}

export function decodeLocalPathHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "buzz-local:" || url.hostname !== "open") return null;
    const path = url.searchParams.get("path");
    return path?.startsWith("/") ? path : path?.startsWith("~/") ? path : null;
  } catch {
    return null;
  }
}
