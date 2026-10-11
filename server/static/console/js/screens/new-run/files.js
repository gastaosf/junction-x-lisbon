// Reading what the operator dropped or picked, as `[{file, path}]` where `path` is the file's own
// relative path: a dropped folder keeps its Urban/ and non-Urban/ sub-directories, which is where
// the labels come from. Nothing here renames a file (contract A18).

// A stop for a folder dropped by mistake (a whole disk): the server takes at most 500 files per
// archive, and a set of panoramas is a few dozen.
export const MAX_DROPPED_FILES = 2000;

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry, out) {
  if (out.length >= MAX_DROPPED_FILES) return;
  if (entry.isFile) {
    const file = await entryFile(entry);
    out.push({ file, path: String(entry.fullPath || "").replace(/^\/+/, "") || file.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries hands a directory over in batches and answers with an empty one at the end.
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) return;
    for (const child of batch) await walk(child, out);
  }
}

/**
 * The files of a drop. The entries are taken before the first await: a DataTransfer is emptied as
 * soon as its event handler returns.
 */
export async function filesFromDrop(dataTransfer) {
  if (!dataTransfer) return [];
  const plain = Array.from(dataTransfer.files || []);
  const entries = Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === "file" && typeof item.webkitGetAsEntry === "function")
    .map((item) => item.webkitGetAsEntry())
    .filter(Boolean);
  if (!entries.length) return plain.map((file) => ({ file, path: file.name }));
  const out = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

/** The files of an <input type="file">; a folder picker gives each its path below that folder. */
export function filesFromInput(input) {
  return Array.from(input.files || [])
    .slice(0, MAX_DROPPED_FILES)
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** Whether a drag carries files (and not a text selection or a link from the page itself). */
export function carriesFiles(event) {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
  return types.includes("Files");
}
